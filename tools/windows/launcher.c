/*
 * launcher.c -- native bingetovlc protocol handler for vlc:// and bingetovlc://.
 *
 * This replaces the PowerShell handler (bingetovlc-handler.ps1). Windows
 * invokes it exactly as:
 *
 *   "C:\path\to\bingetovlc-handler.exe" "%1"
 *
 * The registry passes the full URI as the first (and only) argument, quoted.
 * There is no script host anywhere in the runtime path: the executable decodes
 * the payload, writes a temporary .m3u, launches vlc.exe directly and, when VLC
 * exits, deletes the playlist (it carries an API token). The previous handler
 * was registered as
 *   powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden
 *       -ExecutionPolicy Bypass -File ... "%1"
 * which is precisely the command-line signature antivirus/EDR heuristics flag,
 * so on the machine in the bug report it never ran.
 *
 * C99, single file, no dependencies beyond the C standard library and Win32.
 * Everything Win32 lives behind #ifdef _WIN32, so the decode + playlist path
 * also compiles and runs on Linux -- that is how the byte-exactness of the M3U
 * serialiser is asserted there against tests/fixtures/vectors.json:
 *
 *   zig cc -target x86_64-windows-gnu -static -Os -s -o out.exe launcher.c
 *   zig cc -DLAUNCHER_PORTABLE_TEST -Os -o /tmp/launcher-linux launcher.c
 *   /tmp/launcher-linux --selftest "vlc://open?d=..."
 *
 * The byte-exactness oracle is src/core/m3u.js; the behaviour reference is the
 * PowerShell handler this file replaces. See docs/SPEC.md sections 2, 3, 6, 7.
 *
 * Exit codes (docs/SPEC.md section 6):
 *   0 ok / 2 malformed URI / 3 bad or unsupported payload / 4 VLC not found /
 *   5 write failure
 */

#if !defined(_WIN32) && !defined(_POSIX_C_SOURCE)
#  define _POSIX_C_SOURCE 200809L
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <time.h>
#include <ctype.h>
#include <errno.h>

#ifdef _WIN32
#  define WIN32_LEAN_AND_MEAN
#  include <windows.h>
#  include <fcntl.h>
#  include <io.h>
#else
#  include <sys/stat.h>
#  include <sys/types.h>
#  include <unistd.h>
#  include <dirent.h>
#  include <sys/wait.h>
#  include <pwd.h>
#endif

#ifndef LAUNCHER_PORTABLE_TEST
#  define LAUNCHER_PORTABLE_TEST 0
#endif

/*
 * Fed from package.json by build-launcher.sh and by CI, so the version a bug
 * report quotes is a version the project actually released. The fallback only
 * applies to a bare `zig cc` invocation.
 */
#ifndef HANDLER_VERSION
#  define HANDLER_VERSION "0.0.0-dev"
#endif

#define EXIT_OK        0
#define EXIT_MALFORMED 2
#define EXIT_PAYLOAD   3
#define EXIT_NOVLC     4
#define EXIT_WRITE     5

#define LOG_ROTATE_BYTES (1024 * 1024)
#define PRUNE_AGE_SECONDS (7 * 24 * 60 * 60)

/* ===========================================================================
 * Small utilities
 * =========================================================================== */

static void *xmalloc(size_t n) {
    void *p = malloc(n ? n : 1);
    if (!p) { fputs("bingetovlc: out of memory\n", stderr); exit(EXIT_WRITE); }
    return p;
}

static void *xrealloc(void *p, size_t n) {
    void *q = realloc(p, n ? n : 1);
    if (!q) { fputs("bingetovlc: out of memory\n", stderr); exit(EXIT_WRITE); }
    return q;
}

static char *xstrdup(const char *s) {
    size_t n;
    char *p;
    if (!s) return NULL;
    n = strlen(s);
    p = (char *)xmalloc(n + 1);
    memcpy(p, s, n + 1);
    return p;
}

/* A growable byte buffer; always NUL-terminated after buf_detach(). */
typedef struct {
    char *data;
    size_t len;
    size_t cap;
} Buf;

static void buf_init(Buf *b) { b->data = NULL; b->len = 0; b->cap = 0; }

static void buf_reserve(Buf *b, size_t extra) {
    size_t need = b->len + extra + 1;
    if (need <= b->cap) return;
    {
        size_t ncap = b->cap ? b->cap : 128;
        while (ncap < need) ncap *= 2;
        b->data = (char *)xrealloc(b->data, ncap);
        b->cap = ncap;
    }
}

static void buf_putn(Buf *b, const char *s, size_t n) {
    if (n == 0) return;
    buf_reserve(b, n);
    memcpy(b->data + b->len, s, n);
    b->len += n;
}

static void buf_puts(Buf *b, const char *s) { buf_putn(b, s, strlen(s)); }
static void buf_putc(Buf *b, char c) { buf_reserve(b, 1); b->data[b->len++] = c; }

static char *buf_detach(Buf *b) {
    char *d;
    buf_reserve(b, 0);
    b->data[b->len] = '\0';
    d = b->data;
    b->data = NULL;
    b->len = 0;
    b->cap = 0;
    return d;
}

static void buf_free(Buf *b) {
    free(b->data);
    b->data = NULL;
    b->len = 0;
    b->cap = 0;
}

static char *path_join(const char *a, const char *b) {
    Buf out;
    buf_init(&out);
    if (a && *a) {
        buf_puts(&out, a);
        /* Match the separator the base already uses: a Windows path joined with
           '/' produced "C:\Program Files\VideoLAN\VLC/vlc.exe", which works for
           CreateProcess but renders as a broken DefaultIcon value in the
           registry. */
        char sep = strchr(a, '\\') ? '\\' : '/';
        if (out.len > 0 && out.data[out.len - 1] != '/' && out.data[out.len - 1] != '\\')
            buf_putc(&out, sep);
    }
    buf_puts(&out, b ? b : "");
    return buf_detach(&out);
}

static int ci_prefix(const char *a, const char *b, size_t n) {
    size_t i;
    for (i = 0; i < n; i++) {
        if (tolower((unsigned char)a[i]) != tolower((unsigned char)b[i])) return 0;
    }
    return 1;
}

static int ci_contains(const char *hay, size_t haylen, const char *needle) {
    size_t nl = strlen(needle), i;
    if (nl == 0 || nl > haylen) return 0;
    for (i = 0; i + nl <= haylen; i++) if (ci_prefix(hay + i, needle, nl)) return 1;
    return 0;
}

/* ===========================================================================
 * UTF-8 and the JavaScript \s class
 *
 * JavaScript's \s is [\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f
 * \u205f\u3000\ufeff]. oneLine() in src/core/m3u.js collapses runs of it, so
 * "ASCII whitespace only" is not enough: decode UTF-8 and match the real set.
 * =========================================================================== */

static int js_is_space(uint32_t c) {
    switch (c) {
        case 0x09: case 0x0A: case 0x0B: case 0x0C: case 0x0D: case 0x20:
        case 0xA0: case 0x1680:
        case 0x2028: case 0x2029: case 0x202F: case 0x205F: case 0x3000: case 0xFEFF:
            return 1;
        default:
            return (c >= 0x2000 && c <= 0x200A);
    }
}

/* One decoded code point. `raw` means "invalid UTF-8 byte: emit it verbatim",
 * so a malformed input is never silently re-encoded into something else. */
typedef struct { uint32_t cp; int raw; } Ch;

static int utf8_next(const char *s, size_t len, size_t *pos, Ch *out) {
    unsigned char b0;
    if (*pos >= len) return 0;
    b0 = (unsigned char)s[*pos];
    if (b0 < 0x80) { out->cp = b0; out->raw = 0; (*pos)++; return 1; }
    if (b0 >= 0xC2 && b0 <= 0xDF && *pos + 1 < len) {
        unsigned char b1 = (unsigned char)s[*pos + 1];
        if ((b1 & 0xC0) == 0x80) {
            out->cp = ((uint32_t)(b0 & 0x1F) << 6) | (uint32_t)(b1 & 0x3F);
            out->raw = 0; *pos += 2; return 1;
        }
    } else if (b0 >= 0xE0 && b0 <= 0xEF && *pos + 2 < len) {
        unsigned char b1 = (unsigned char)s[*pos + 1];
        unsigned char b2 = (unsigned char)s[*pos + 2];
        if ((b1 & 0xC0) == 0x80 && (b2 & 0xC0) == 0x80) {
            uint32_t cp = ((uint32_t)(b0 & 0x0F) << 12) | ((uint32_t)(b1 & 0x3F) << 6) | (uint32_t)(b2 & 0x3F);
            if (cp >= 0x800) { out->cp = cp; out->raw = 0; *pos += 3; return 1; }
        }
    } else if (b0 >= 0xF0 && b0 <= 0xF4 && *pos + 3 < len) {
        unsigned char b1 = (unsigned char)s[*pos + 1];
        unsigned char b2 = (unsigned char)s[*pos + 2];
        unsigned char b3 = (unsigned char)s[*pos + 3];
        if ((b1 & 0xC0) == 0x80 && (b2 & 0xC0) == 0x80 && (b3 & 0xC0) == 0x80) {
            uint32_t cp = ((uint32_t)(b0 & 0x07) << 18) | ((uint32_t)(b1 & 0x3F) << 12) |
                          ((uint32_t)(b2 & 0x3F) << 6) | (uint32_t)(b3 & 0x3F);
            if (cp >= 0x10000 && cp <= 0x10FFFF) { out->cp = cp; out->raw = 0; *pos += 4; return 1; }
        }
    }
    out->cp = b0; out->raw = 1; (*pos)++;
    return 1;
}

static void emit_cp_utf8(Buf *b, uint32_t cp) {
    if (cp < 0x80) {
        buf_putc(b, (char)cp);
    } else if (cp < 0x800) {
        buf_putc(b, (char)(0xC0 | (cp >> 6)));
        buf_putc(b, (char)(0x80 | (cp & 0x3F)));
    } else if (cp < 0x10000) {
        buf_putc(b, (char)(0xE0 | (cp >> 12)));
        buf_putc(b, (char)(0x80 | ((cp >> 6) & 0x3F)));
        buf_putc(b, (char)(0x80 | (cp & 0x3F)));
    } else {
        buf_putc(b, (char)(0xF0 | (cp >> 18)));
        buf_putc(b, (char)(0x80 | ((cp >> 12) & 0x3F)));
        buf_putc(b, (char)(0x80 | ((cp >> 6) & 0x3F)));
        buf_putc(b, (char)(0x80 | (cp & 0x3F)));
    }
}

static void emit_ch(Buf *b, const Ch *c) {
    if (c->raw) { buf_putc(b, (char)(c->cp & 0xFF)); return; }
    emit_cp_utf8(b, c->cp);
}

/*
 * oneLine(): a title is a single line by definition. Mirrors
 *   String(text).replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim()
 */
static char *one_line(const char *in) {
    size_t len, pos, i, count, w;
    Ch *src, *mid;
    Buf out;

    if (!in) return xstrdup("");
    len = strlen(in);
    src = (Ch *)xmalloc((len + 1) * sizeof(Ch));
    mid = (Ch *)xmalloc((len + 1) * sizeof(Ch));

    /* Pass 1: runs of CR/LF/TAB become one space. */
    pos = 0;
    count = 0;
    while (pos < len) {
        Ch c;
        utf8_next(in, len, &pos, &c);
        if (!c.raw && (c.cp == '\r' || c.cp == '\n' || c.cp == '\t')) {
            while (pos < len) {
                Ch d;
                size_t save = pos;
                utf8_next(in, len, &pos, &d);
                if (d.raw || (d.cp != '\r' && d.cp != '\n' && d.cp != '\t')) { pos = save; break; }
            }
            src[count].cp = ' ';
            src[count].raw = 0;
            count++;
        } else {
            src[count++] = c;
        }
    }

    /* Pass 2: runs of two or more JS-whitespace collapse to one space. */
    i = 0;
    w = 0;
    while (i < count) {
        if (!src[i].raw && js_is_space(src[i].cp)) {
            size_t start = i;
            while (i < count && !src[i].raw && js_is_space(src[i].cp)) i++;
            if (i - start >= 2) { mid[w].cp = ' '; mid[w].raw = 0; w++; }
            else mid[w++] = src[start];
        } else {
            mid[w++] = src[i++];
        }
    }

    /* Pass 3: trim leading and trailing JS-whitespace. */
    {
        size_t begin = 0, end = w;
        while (begin < end && !mid[begin].raw && js_is_space(mid[begin].cp)) begin++;
        while (end > begin && !mid[end - 1].raw && js_is_space(mid[end - 1].cp)) end--;
        buf_init(&out);
        for (i = begin; i < end; i++) emit_ch(&out, &mid[i]);
    }

    free(src);
    free(mid);
    return buf_detach(&out);
}

/* safeUrl(): strip control characters so a URL cannot change the line
 * structure of an .m3u. Byte-level is safe: every byte of a UTF-8 multi-byte
 * sequence is >= 0x80. */
static char *safe_url(const char *in) {
    Buf out;
    size_t i, len;
    buf_init(&out);
    if (!in) return buf_detach(&out);
    len = strlen(in);
    for (i = 0; i < len; i++) {
        unsigned char c = (unsigned char)in[i];
        if (c < 0x20 || c == 0x7F) continue;
        buf_putc(&out, (char)c);
    }
    return buf_detach(&out);
}

/* True when any code point is a control character or JS whitespace. */
static int contains_unsafe(const char *s) {
    size_t len, pos = 0;
    if (!s) return 0;
    len = strlen(s);
    while (pos < len) {
        Ch c;
        utf8_next(s, len, &pos, &c);
        if (c.raw) continue;
        if (c.cp < 0x20 || c.cp == 0x7F || js_is_space(c.cp)) return 1;
    }
    return 0;
}

/* ^[A-Za-z][A-Za-z0-9+.-]*:// */
static int test_absolute_url(const char *s) {
    size_t i;
    if (!s || !*s) return 0;
    if (!((s[0] >= 'A' && s[0] <= 'Z') || (s[0] >= 'a' && s[0] <= 'z'))) return 0;
    i = 1;
    while (s[i]) {
        char c = s[i];
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
            c == '+' || c == '.' || c == '-') i++;
        else break;
    }
    return s[i] == ':' && s[i + 1] == '/' && s[i + 2] == '/';
}

static int test_safe_url(const char *s) { return test_absolute_url(s) && !contains_unsafe(s); }

static int test_safe_item_id(const char *s) {
    size_t i, len;
    if (!s || !*s) return 0;
    len = strlen(s);
    if (len > 64) return 0;
    if (contains_unsafe(s)) return 0;
    for (i = 0; i < len; i++) if (s[i] == '/' || s[i] == '?') return 0;
    return 1;
}

/* ===========================================================================
 * A very small JSON parser
 *
 * Only what a payload needs: objects, arrays, strings (with \u escapes and
 * surrogate pairs), numbers, booleans and null. Non-ASCII is kept as raw UTF-8,
 * which is what JSON.stringify produces.
 * =========================================================================== */

enum { JV_NULL, JV_BOOL, JV_NUM, JV_STR, JV_ARR, JV_OBJ };

typedef struct JVal {
    int type;
    int b;
    double num;
    char *str;
    size_t slen;
    struct JVal **arr;
    int alen;
    char **keys;
    struct JVal **vals;
    int klen;
} JVal;

typedef struct { const char *s; size_t len; size_t pos; int err; } JP;

static JVal *jval_new(int type) {
    JVal *v = (JVal *)xmalloc(sizeof(JVal));
    memset(v, 0, sizeof(JVal));
    v->type = type;
    return v;
}

static void jval_free(JVal *v) {
    int i;
    if (!v) return;
    if (v->type == JV_STR) free(v->str);
    if (v->type == JV_ARR) {
        for (i = 0; i < v->alen; i++) jval_free(v->arr[i]);
        free(v->arr);
    }
    if (v->type == JV_OBJ) {
        for (i = 0; i < v->klen; i++) { free(v->keys[i]); jval_free(v->vals[i]); }
        free(v->keys);
        free(v->vals);
    }
    free(v);
}

static void jp_ws(JP *p) {
    while (p->pos < p->len) {
        char c = p->s[p->pos];
        if (c == ' ' || c == '\t' || c == '\n' || c == '\r') p->pos++;
        else break;
    }
}

static int hex4(const char *s, unsigned *out) {
    unsigned v = 0;
    int i;
    for (i = 0; i < 4; i++) {
        char c = s[i];
        v <<= 4;
        if (c >= '0' && c <= '9') v |= (unsigned)(c - '0');
        else if (c >= 'a' && c <= 'f') v |= (unsigned)(c - 'a' + 10);
        else if (c >= 'A' && c <= 'F') v |= (unsigned)(c - 'A' + 10);
        else return 0;
    }
    *out = v;
    return 1;
}

static char *jp_string_raw(JP *p, size_t *outlen) {
    Buf b;
    buf_init(&b);
    p->pos++; /* opening quote */
    while (p->pos < p->len) {
        unsigned char c = (unsigned char)p->s[p->pos++];
        if (c == '"') { *outlen = b.len; return buf_detach(&b); }
        if (c == '\\') {
            char e;
            if (p->pos >= p->len) { p->err = 1; break; }
            e = p->s[p->pos++];
            switch (e) {
                case '"': buf_putc(&b, '"'); break;
                case '\\': buf_putc(&b, '\\'); break;
                case '/': buf_putc(&b, '/'); break;
                case 'b': buf_putc(&b, '\b'); break;
                case 'f': buf_putc(&b, '\f'); break;
                case 'n': buf_putc(&b, '\n'); break;
                case 'r': buf_putc(&b, '\r'); break;
                case 't': buf_putc(&b, '\t'); break;
                case 'u': {
                    unsigned cp;
                    uint32_t code;
                    if (p->pos + 4 > p->len || !hex4(p->s + p->pos, &cp)) { p->err = 1; break; }
                    p->pos += 4;
                    code = cp;
                    if (code >= 0xD800 && code <= 0xDBFF && p->pos + 6 <= p->len &&
                        p->s[p->pos] == '\\' && p->s[p->pos + 1] == 'u') {
                        unsigned lo;
                        if (hex4(p->s + p->pos + 2, &lo) && lo >= 0xDC00 && lo <= 0xDFFF) {
                            code = 0x10000 + ((code - 0xD800) << 10) + (lo - 0xDC00);
                            p->pos += 6;
                        }
                    }
                    emit_cp_utf8(&b, code);
                    break;
                }
                default: p->err = 1; break;
            }
            if (p->err) break;
        } else {
            buf_putc(&b, (char)c);
        }
    }
    p->err = 1;
    buf_free(&b);
    return NULL;
}

static JVal *jp_value(JP *p);

static JVal *jp_array(JP *p) {
    JVal *v = jval_new(JV_ARR);
    p->pos++; /* '[' */
    jp_ws(p);
    if (p->pos < p->len && p->s[p->pos] == ']') { p->pos++; return v; }
    for (;;) {
        JVal *item;
        jp_ws(p);
        item = jp_value(p);
        if (!item) break;
        v->arr = (JVal **)xrealloc(v->arr, sizeof(JVal *) * (size_t)(v->alen + 1));
        v->arr[v->alen++] = item;
        jp_ws(p);
        if (p->pos >= p->len) { p->err = 1; break; }
        {
            char c = p->s[p->pos++];
            if (c == ']') break;
            if (c != ',') { p->err = 1; break; }
        }
    }
    if (p->err) { jval_free(v); return NULL; }
    return v;
}

static JVal *jp_object(JP *p) {
    JVal *v = jval_new(JV_OBJ);
    p->pos++; /* '{' */
    jp_ws(p);
    if (p->pos < p->len && p->s[p->pos] == '}') { p->pos++; return v; }
    for (;;) {
        char *key;
        size_t klen = 0;
        JVal *val;
        jp_ws(p);
        if (p->pos >= p->len || p->s[p->pos] != '"') { p->err = 1; break; }
        key = jp_string_raw(p, &klen);
        if (!key) break;
        jp_ws(p);
        if (p->pos >= p->len || p->s[p->pos] != ':') { free(key); p->err = 1; break; }
        p->pos++;
        jp_ws(p);
        val = jp_value(p);
        if (!val) { free(key); break; }
        v->keys = (char **)xrealloc(v->keys, sizeof(char *) * (size_t)(v->klen + 1));
        v->vals = (JVal **)xrealloc(v->vals, sizeof(JVal *) * (size_t)(v->klen + 1));
        v->keys[v->klen] = key;
        v->vals[v->klen] = val;
        v->klen++;
        jp_ws(p);
        if (p->pos >= p->len) { p->err = 1; break; }
        {
            char c = p->s[p->pos++];
            if (c == '}') break;
            if (c != ',') { p->err = 1; break; }
        }
    }
    if (p->err) { jval_free(v); return NULL; }
    return v;
}

static JVal *jp_value(JP *p) {
    jp_ws(p);
    if (p->pos >= p->len) { p->err = 1; return NULL; }
    {
        char c = p->s[p->pos];
        if (c == '{') return jp_object(p);
        if (c == '[') return jp_array(p);
        if (c == '"') {
            JVal *v = jval_new(JV_STR);
            v->str = jp_string_raw(p, &v->slen);
            if (!v->str) { jval_free(v); return NULL; }
            return v;
        }
        if (c == 't' && p->pos + 4 <= p->len && strncmp(p->s + p->pos, "true", 4) == 0) {
            JVal *v = jval_new(JV_BOOL); v->b = 1; p->pos += 4; return v;
        }
        if (c == 'f' && p->pos + 5 <= p->len && strncmp(p->s + p->pos, "false", 5) == 0) {
            JVal *v = jval_new(JV_BOOL); v->b = 0; p->pos += 5; return v;
        }
        if (c == 'n' && p->pos + 4 <= p->len && strncmp(p->s + p->pos, "null", 4) == 0) {
            JVal *v = jval_new(JV_NULL); p->pos += 4; return v;
        }
        /* number */
        {
            size_t start = p->pos;
            char *endp = NULL;
            double num;
            JVal *v;
            if (c == '-' || c == '+') p->pos++;
            while (p->pos < p->len) {
                char d = p->s[p->pos];
                if ((d >= '0' && d <= '9') || d == '.' || d == 'e' || d == 'E' || d == '+' || d == '-') p->pos++;
                else break;
            }
            if (p->pos == start) { p->err = 1; return NULL; }
            num = strtod(p->s + start, &endp);
            if (endp == p->s + start) { p->err = 1; return NULL; }
            v = jval_new(JV_NUM);
            v->num = num;
            return v;
        }
    }
}

static JVal *json_parse(const char *text, size_t len) {
    JP p;
    JVal *v;
    p.s = text; p.len = len; p.pos = 0; p.err = 0;
    v = jp_value(&p);
    if (!v) return NULL;
    jp_ws(&p);
    if (p.pos != p.len) { jval_free(v); return NULL; }
    return v;
}

static JVal *jget(JVal *obj, const char *key) {
    int i;
    if (!obj || obj->type != JV_OBJ) return NULL;
    for (i = 0; i < obj->klen; i++) if (strcmp(obj->keys[i], key) == 0) return obj->vals[i];
    return NULL;
}

static char *jget_str(JVal *obj, const char *key) {
    JVal *v = jget(obj, key);
    if (v && v->type == JV_STR) return v->str;
    return NULL;
}

static JVal *jget_num(JVal *obj, const char *key) {
    JVal *v = jget(obj, key);
    if (v && v->type == JV_NUM) return v;
    return NULL;
}

static int jtruthy(JVal *v) {
    if (!v) return 0;
    switch (v->type) {
        case JV_NULL: return 0;
        case JV_BOOL: return v->b;
        case JV_NUM: return v->num != 0.0;
        case JV_STR: return v->slen > 0;
        default: return 1;
    }
}

/* ===========================================================================
 * Payload model
 * =========================================================================== */

typedef struct {
    char *u; int has_u;
    char *i; int has_i;
    char *t; int has_t;
    int has_s; double s;
    int has_e; double e;
    int has_d; double d;
} Item;

typedef struct {
    int v;
    char *server;
    char *token; int has_token;
    char *title; int has_title;
    int has_n; long long n;
    Item *items; int nitems;

    int opt_fs, opt_one, opt_exit;
    int has_start; double start;
    int opt_cache; double cache;
    char *referrer; int opt_referrer;
    char *ua; int opt_ua;
} Payload;

static void payload_free(Payload *p) {
    int i;
    if (!p) return;
    free(p->server);
    free(p->token);
    free(p->title);
    if (p->items) {
        for (i = 0; i < p->nitems; i++) {
            free(p->items[i].u);
            free(p->items[i].i);
            free(p->items[i].t);
        }
        free(p->items);
    }
    free(p->referrer);
    free(p->ua);
    free(p);
}

/* A finite double test that needs no libm. */
static int is_finite_d(double v) {
    return v == v && v <= 1.7e308 && v >= -1.7e308;
}

/* Format a double the way JS String(Math.trunc(n)).padStart(2, "0") does. */
static char *pad2(int has, double value) {
    char tmp[64];
    if (!has || !is_finite_d(value)) return xstrdup("00");
    {
        long long n = (long long)value; /* truncates toward zero, like Math.trunc */
        snprintf(tmp, sizeof(tmp), "%lld", n);
        if (strlen(tmp) >= 2) return xstrdup(tmp);
        {
            char out[4];
            out[0] = '0';
            out[1] = tmp[0];
            out[2] = '\0';
            return xstrdup(out);
        }
    }
}

static char *resolve_item_url(const Payload *p, const Item *x) {
    Buf b;
    const char *server, *token;
    size_t sl;
    if (x->has_u && x->u && x->u[0]) return xstrdup(x->u);
    server = p->server ? p->server : "";
    token = p->token ? p->token : "";
    sl = strlen(server);
    while (sl > 0 && server[sl - 1] == '/') sl--;
    buf_init(&b);
    buf_putn(&b, server, sl);
    buf_puts(&b, "/Videos/");
    buf_puts(&b, (x->i && x->i[0]) ? x->i : "");
    buf_puts(&b, "/stream?Static=true&api_key=");
    buf_puts(&b, token);
    return buf_detach(&b);
}

/* floor(v + 0.5): JavaScript Math.round, which rounds halves toward +Infinity. */
static long long round_half_up(double v) {
    double x = v + 0.5;
    long long t = (long long)x;
    if ((double)t > x) t--;
    return t;
}

static char *m3u_duration(const Item *x) {
    char tmp[64];
    if (!x->has_d) return xstrdup("-1");
    if (!is_finite_d(x->d) || x->d <= 0) return xstrdup("-1");
    snprintf(tmp, sizeof(tmp), "%lld", round_half_up(x->d));
    return xstrdup(tmp);
}

static char *item_label(const Payload *p, const Item *x) {
    char *s1, *s2, *out;
    Buf b;
    if (x->has_t && x->t && x->t[0]) return one_line(x->t);
    if (x->has_s || x->has_e) {
        s1 = pad2(x->has_s, x->s);
        s2 = pad2(x->has_e, x->e);
        buf_init(&b);
        buf_putc(&b, 'S');
        buf_puts(&b, s1);
        buf_putc(&b, 'E');
        buf_puts(&b, s2);
        out = buf_detach(&b);
        free(s1);
        free(s2);
        return out;
    }
    return resolve_item_url(p, x);
}

/* ===========================================================================
 * M3U serialisation -- MUST match src/core/m3u.js byte-for-byte.
 * =========================================================================== */

static char *build_m3u(const Payload *p) {
    Buf b;
    int k;
    buf_init(&b);
    buf_puts(&b, "#EXTM3U\n");

    if (p->has_title && p->title && p->title[0]) {
        char *t = one_line(p->title);
        buf_puts(&b, "#PLAYLIST:");
        buf_puts(&b, t);
        buf_putc(&b, '\n');
        free(t);
    }

    for (k = 0; k < p->nitems; k++) {
        const Item *x = &p->items[k];
        char *dur = m3u_duration(x);
        char *label = item_label(p, x);
        char *url = resolve_item_url(p, x);
        char *safe = safe_url(url);

        buf_puts(&b, "#EXTINF:");
        buf_puts(&b, dur);
        buf_putc(&b, ',');
        buf_puts(&b, label);
        buf_putc(&b, '\n');

        if (p->opt_cache) {
            char tmp[64];
            snprintf(tmp, sizeof(tmp), "#EXTVLCOPT:network-caching=%lld\n", round_half_up(p->cache));
            buf_puts(&b, tmp);
        }
        if (p->opt_referrer && p->referrer) {
            char *r = one_line(p->referrer);
            buf_puts(&b, "#EXTVLCOPT:http-referrer=");
            buf_puts(&b, r);
            buf_putc(&b, '\n');
            free(r);
        }
        if (p->opt_ua && p->ua) {
            char *r = one_line(p->ua);
            buf_puts(&b, "#EXTVLCOPT:http-user-agent=");
            buf_puts(&b, r);
            buf_putc(&b, '\n');
            free(r);
        }
        buf_puts(&b, safe);
        buf_putc(&b, '\n');

        free(dur);
        free(label);
        free(url);
        free(safe);
    }
    return buf_detach(&b);
}

/* ===========================================================================
 * Percent-decoding and base64url
 * =========================================================================== */

static int hexval(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

/* Percent-decode like Uri.UnescapeDataString / decodeURIComponent: %XX becomes
 * a byte; anything else is copied literally. */
static char *percent_decode_len(const char *in, size_t len) {
    Buf b;
    size_t i;
    buf_init(&b);
    for (i = 0; i < len; i++) {
        if (in[i] == '%' && i + 2 < len) {
            int hi = hexval(in[i + 1]);
            int lo = hexval(in[i + 2]);
            if (hi >= 0 && lo >= 0) {
                buf_putc(&b, (char)((hi << 4) | lo));
                i += 2;
                continue;
            }
        }
        buf_putc(&b, in[i]);
    }
    return buf_detach(&b);
}

static char *percent_decode(const char *in) {
    if (!in) return xstrdup("");
    return percent_decode_len(in, strlen(in));
}

static const char B64_ALPHABET[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/*
 * base64url -> bytes. Tolerant about spelling (padding, the plain base64 `+/`,
 * whitespace), strict about the bytes: leftover bits must be zero, which is the
 * truncation signal. Mirrors base64UrlDecodeBytes() in src/core/payload.js.
 */
static int b64url_decode(const char *in, char **out, size_t *outlen, char **err) {
    Buf cleaned;
    Buf bytes;
    size_t i, len;
    uint32_t buffer = 0;
    int bits = 0;

    buf_init(&cleaned);
    buf_init(&bytes);
    if (!in) { if (err) *err = xstrdup("empty base64url value"); return 0; }
    len = strlen(in);

    for (i = 0; i < len; i++) {
        char c = in[i];
        if (c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\v' || c == '\f') continue;
        if (c == '+') c = '-';
        else if (c == '/') c = '_';
        buf_putc(&cleaned, c);
    }
    while (cleaned.len > 0 && cleaned.data[cleaned.len - 1] == '=') cleaned.len--;
    cleaned.data[cleaned.len] = '\0';

    for (i = 0; i < cleaned.len; i++) {
        char c = cleaned.data[i];
        const char *hit = strchr(B64_ALPHABET, c);
        uint32_t value;
        if (!hit || c == '\0') {
            char msg[64];
            snprintf(msg, sizeof(msg), "invalid base64url character: %c", c);
            if (err) *err = xstrdup(msg);
            buf_free(&cleaned);
            buf_free(&bytes);
            return 0;
        }
        value = (uint32_t)(hit - B64_ALPHABET);
        buffer = (buffer << 6) | value;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            buf_putc(&bytes, (char)((buffer >> bits) & 0xFF));
            buffer &= (bits > 0) ? ((1u << bits) - 1u) : 0u;
        }
    }
    if (bits > 0 && buffer != 0) {
        if (err) *err = xstrdup("payload was truncated or corrupted in transit");
        buf_free(&cleaned);
        buf_free(&bytes);
        return 0;
    }
    buf_free(&cleaned);
    *outlen = bytes.len;
    *out = buf_detach(&bytes);
    return 1;
}

/* ===========================================================================
 * URI parsing
 * =========================================================================== */

typedef struct { char *key; char *value; } Param;

static char *trim_ascii(const char *s) {
    size_t start = 0, end;
    Buf b;
    if (!s) return xstrdup("");
    end = strlen(s);
    while (start < end && (s[start] == ' ' || s[start] == '\t' || s[start] == '\r' || s[start] == '\n')) start++;
    while (end > start) {
        char c = s[end - 1];
        if (c == ' ' || c == '\t' || c == '\r' || c == '\n') end--;
        else break;
    }
    buf_init(&b);
    buf_putn(&b, s + start, end - start);
    return buf_detach(&b);
}

/* Mirrors Get-TitleFromUrl: last path segment, else the host. */
static char *get_title_from_url(const char *url) {
    const char *scheme = strstr(url, "://");
    const char *p, *slash;
    char *host;
    if (!scheme) return xstrdup("");
    p = scheme + 3;
    slash = strchr(p, '/');
    {
        const char *h = p;
        while (*h && *h != '/' && *h != '?' && *h != '#') h++;
        host = percent_decode_len(p, (size_t)(h - p));
    }
    if (!slash) { free(host); return xstrdup(""); }
    {
        const char *pa = slash + 1;
        const char *pe = pa;
        const char *seg;
        while (*pe && *pe != '?' && *pe != '#') pe++;
        while (pe > pa && pe[-1] == '/') pe--;
        if (pe == pa) { free(host); return xstrdup(""); }
        seg = pe;
        while (seg > pa && seg[-1] != '/') seg--;
        {
            char *out = percent_decode_len(seg, (size_t)(pe - seg));
            free(host);
            return out;
        }
    }
}

static void parse_params(const char *query, Param **out, int *outn) {
    /* Split on '&', then on the first '='. First occurrence of a key wins. */
    Buf tok;
    Param *list = NULL;
    int n = 0;
    size_t i, len;
    buf_init(&tok);
    len = strlen(query);
    for (i = 0; i <= len; i++) {
        if (i == len || query[i] == '&') {
            char *pair = buf_detach(&tok);
            if (*pair) {
                char *eq = strchr(pair, '=');
                if (eq) {
                    int dup = 0, j;
                    char *key = percent_decode_len(pair, (size_t)(eq - pair));
                    char *value = percent_decode(eq + 1);
                    for (j = 0; j < n; j++) if (strcmp(list[j].key, key) == 0) { dup = 1; break; }
                    if (dup) { free(key); free(value); }
                    else {
                        list = (Param *)xrealloc(list, sizeof(Param) * (size_t)(n + 1));
                        list[n].key = key;
                        list[n].value = value;
                        n++;
                    }
                }
                free(pair);
            }
            buf_init(&tok);
        } else {
            buf_putc(&tok, query[i]);
        }
    }
    *out = list;
    *outn = n;
}

static Param *find_param(Param *list, int n, const char *key) {
    int i;
    for (i = 0; i < n; i++) if (strcmp(list[i].key, key) == 0) return &list[i];
    return NULL;
}

/* ^[A-Za-z][A-Za-z0-9+.-]*://, returning the scheme length. */
static int match_scheme(const char *s, size_t *schemelen) {
    size_t i = 1;
    if (!s || !s[0]) return 0;
    if (!((s[0] >= 'A' && s[0] <= 'Z') || (s[0] >= 'a' && s[0] <= 'z'))) return 0;
    while (s[i]) {
        char c = s[i];
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
            c == '+' || c == '.' || c == '-') i++;
        else break;
    }
    if (s[i] == ':' && s[i + 1] == '/' && s[i + 2] == '/') { *schemelen = i; return 1; }
    return 0;
}

static Payload *make_simple(const char *url, const char *title) {
    Payload *p = (Payload *)xmalloc(sizeof(Payload));
    memset(p, 0, sizeof(Payload));
    p->v = 1;
    p->server = xstrdup("");
    p->items = (Item *)xmalloc(sizeof(Item));
    memset(p->items, 0, sizeof(Item));
    p->nitems = 1;
    if (url && url[0]) { p->items[0].u = xstrdup(url); p->items[0].has_u = 1; }
    if (title && title[0]) { p->items[0].t = xstrdup(title); p->items[0].has_t = 1; }
    return p;
}

static int validate_payload(const Payload *p, Buf *err) {
    int uses_ids = 0, k;
    if (p->v != 1 && p->v != 2) {
        char tmp[96];
        snprintf(tmp, sizeof(tmp), "unsupported payload version %d (this build speaks 1, 2)", p->v);
        buf_puts(err, tmp);
        return 0;
    }
    if (p->nitems <= 0) { buf_puts(err, "payload has no items"); return 0; }
    if (p->has_n && p->n != (long long)p->nitems) {
        char tmp[128];
        snprintf(tmp, sizeof(tmp), "payload is incomplete: it declares %lld items but contains %d", p->n, p->nitems);
        buf_puts(err, tmp);
        return 0;
    }

    for (k = 0; k < p->nitems; k++) {
        const Item *x = &p->items[k];
        if (x->has_u) {
            if (!test_safe_url(x->u)) {
                buf_puts(err, "payload item URL is not an absolute URL, or contains whitespace/control characters");
                return 0;
            }
        } else if (x->has_i) {
            if (!test_safe_item_id(x->i)) {
                buf_puts(err, "payload item id is empty, too long, or contains characters that would change the generated URL");
                return 0;
            }
            uses_ids = 1;
        } else {
            buf_puts(err, "payload item has neither a url nor an id");
            return 0;
        }
    }

    if (uses_ids) {
        if (!test_safe_url(p->server ? p->server : "")) {
            buf_puts(err, "payload carries item ids but no usable server address to build their URLs with");
            return 0;
        }
        if (!p->has_token || !p->token || !p->token[0]) {
            buf_puts(err, "payload carries item ids but no token to build their URLs with");
            return 0;
        }
        if (contains_unsafe(p->token)) {
            buf_puts(err, "payload token contains whitespace or control characters");
            return 0;
        }
        {
            size_t i, tl = strlen(p->token);
            for (i = 0; i < tl; i++) {
                char c = p->token[i];
                int ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                         (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '~' || c == '-';
                if (!ok) {
                    buf_puts(err, "payload token contains characters that would need percent-encoding");
                    return 0;
                }
            }
        }
    }
    return 1;
}

static int load_payload(JVal *root, Payload **out, Buf *err) {
    Payload *p;
    JVal *items, *opts;
    int k;

    if (!root || root->type != JV_OBJ) { buf_puts(err, "payload is not an object"); return 0; }

    p = (Payload *)xmalloc(sizeof(Payload));
    memset(p, 0, sizeof(Payload));

    {
        JVal *v = jget(root, "v");
        p->v = (v && v->type == JV_NUM) ? (int)v->num : -1;
    }
    items = jget(root, "items");
    if (!items || items->type != JV_ARR || items->alen == 0) {
        buf_puts(err, "payload has no items");
        payload_free(p);
        return 0;
    }
    p->nitems = items->alen;
    p->items = (Item *)xmalloc(sizeof(Item) * (size_t)p->nitems);
    memset(p->items, 0, sizeof(Item) * (size_t)p->nitems);

    {
        JVal *n = jget_num(root, "n");
        if (n) { p->has_n = 1; p->n = (long long)n->num; }
    }
    {
        char *s = jget_str(root, "server");
        p->server = xstrdup(s ? s : "");
    }
    {
        char *s = jget_str(root, "token");
        if (s) { p->token = xstrdup(s); p->has_token = 1; }
    }
    {
        char *s = jget_str(root, "title");
        if (s) { p->title = xstrdup(s); p->has_title = 1; }
    }

    for (k = 0; k < p->nitems; k++) {
        JVal *it = items->arr[k];
        Item *x = &p->items[k];
        char *s;
        if (!it || it->type != JV_OBJ) {
            buf_puts(err, "payload item is not an object");
            payload_free(p);
            return 0;
        }
        s = jget_str(it, "u");
        if (s && s[0]) { x->u = xstrdup(s); x->has_u = 1; }
        s = jget_str(it, "i");
        if (s && s[0]) { x->i = xstrdup(s); x->has_i = 1; }
        s = jget_str(it, "t");
        if (s) { x->t = xstrdup(s); x->has_t = 1; }
        {
            JVal *v = jget_num(it, "s");
            if (v) { x->has_s = 1; x->s = v->num; }
        }
        {
            JVal *v = jget_num(it, "e");
            if (v) { x->has_e = 1; x->e = v->num; }
        }
        {
            JVal *v = jget_num(it, "d");
            if (v) { x->has_d = 1; x->d = v->num; }
        }
    }

    opts = jget(root, "opts");
    if (opts && opts->type == JV_OBJ) {
        JVal *v;
        p->opt_fs = jtruthy(jget(opts, "fs"));
        p->opt_one = jtruthy(jget(opts, "one"));
        p->opt_exit = jtruthy(jget(opts, "exit"));
        v = jget_num(opts, "start");
        if (v) { p->has_start = 1; p->start = v->num; }
        v = jget(opts, "cache");
        if (jtruthy(v)) {
            p->opt_cache = 1;
            if (v->type == JV_NUM) p->cache = v->num;
            else if (v->type == JV_STR) p->cache = atof(v->str);
            else p->cache = 1;
        }
        {
            char *s = jget_str(opts, "referrer");
            if (s && s[0]) { p->referrer = xstrdup(s); p->opt_referrer = 1; }
        }
        {
            char *s = jget_str(opts, "ua");
            if (s && s[0]) { p->ua = xstrdup(s); p->opt_ua = 1; }
        }
    }

    *out = p;
    return 1;
}

/*
 * Resolve a raw handler argument to a validated payload. Returns 1 on success,
 * 0 on failure with *errcode set to EXIT_MALFORMED or EXIT_PAYLOAD and a
 * human-readable reason in `err`.
 */
static int resolve_payload(const char *raw_uri, Payload **out, int *errcode, Buf *err) {
    char *raw, *scheme, *rest, *pstr, *qstr, *decoded = NULL, *jsontext;
    size_t sl = 0, L, qpos;
    Param *params = NULL;
    int nparams = 0, ok = 0, i;
    JVal *root = NULL;
    size_t blen = 0;

    *errcode = EXIT_MALFORMED;
    if (!raw_uri || !*raw_uri) { buf_puts(err, "no URI argument was supplied"); return 0; }

    raw = trim_ascii(raw_uri);
    L = strlen(raw);
    if (L >= 2) {
        char a = raw[0], b = raw[L - 1];
        if ((a == '"' && b == '"') || (a == '\'' && b == '\'')) {
            memmove(raw, raw + 1, L - 2);
            raw[L - 2] = '\0';
        }
    }

    if (!match_scheme(raw, &sl)) {
        buf_puts(err, "URI is not of the form scheme://...");
        free(raw);
        return 0;
    }
    scheme = (char *)xmalloc(sl + 1);
    for (i = 0; i < (int)sl; i++) scheme[i] = (char)tolower((unsigned char)raw[i]);
    scheme[sl] = '\0';
    rest = raw + sl + 3;

    if (strcmp(scheme, "vlc") != 0 && strcmp(scheme, "bingetovlc") != 0) {
        buf_puts(err, "unsupported scheme: ");
        buf_puts(err, scheme);
        free(scheme);
        free(raw);
        return 0;
    }

    /* Form 3: bare convenience form, scheme://<absolute-url>. */
    if (test_safe_url(rest)) {
        char *title = get_title_from_url(rest);
        Payload *p = make_simple(rest, title);
        free(title);
        if (!validate_payload(p, err)) { payload_free(p); }
        else { *out = p; ok = 1; }
        free(scheme);
        free(raw);
        return ok;
    }

    /* Forms 1 and 2: scheme://open?... (a trailing slash on "open" is fine). */
    qpos = (size_t)-1;
    for (i = 0; rest[i]; i++) if (rest[i] == '?') { qpos = (size_t)i; break; }
    if (qpos == (size_t)-1) { pstr = xstrdup(rest); qstr = xstrdup(""); }
    else {
        pstr = (char *)xmalloc(qpos + 1);
        memcpy(pstr, rest, qpos);
        pstr[qpos] = '\0';
        qstr = xstrdup(rest + qpos + 1);
    }
    {
        size_t pl = strlen(pstr);
        while (pl > 0 && pstr[pl - 1] == '/') pstr[--pl] = '\0';
    }
    if (strcmp(pstr, "open") != 0) {
        buf_puts(err, "unsupported URI path: ");
        buf_puts(err, pstr);
        goto done;
    }
    parse_params(qstr, &params, &nparams);

    {
        Param *d = find_param(params, nparams, "d");
        if (d && d->value && d->value[0]) {
            char *b64err = NULL;
            if (!b64url_decode(d->value, &decoded, &blen, &b64err)) {
                *errcode = EXIT_PAYLOAD;
                buf_puts(err, "payload is not valid base64url: ");
                buf_puts(err, b64err ? b64err : "invalid encoding");
                free(b64err);
                goto done;
            }
            jsontext = (char *)xmalloc(blen + 1);
            memcpy(jsontext, decoded, blen);
            jsontext[blen] = '\0';
            free(decoded);
            decoded = NULL;
            root = json_parse(jsontext, blen);
            free(jsontext);
            if (!root) {
                *errcode = EXIT_PAYLOAD;
                buf_puts(err, "payload is not valid JSON after decoding");
                goto done;
            }
            {
                Payload *p = NULL;
                if (!load_payload(root, &p, err)) { *errcode = EXIT_PAYLOAD; goto done; }
                if (!validate_payload(p, err)) { payload_free(p); *errcode = EXIT_PAYLOAD; goto done; }
                *out = p;
                ok = 1;
                goto done;
            }
        } else {
            Param *u = find_param(params, nparams, "url");
            if (u) {
                if (!test_safe_url(u->value)) {
                    buf_puts(err, "manual url parameter is not an absolute URL, or contains whitespace/control characters");
                    goto done;
                }
                {
                    Param *t = find_param(params, nparams, "t");
                    Payload *p = make_simple(u->value, (t && t->value) ? t->value : NULL);
                    if (!validate_payload(p, err)) { payload_free(p); *errcode = EXIT_PAYLOAD; }
                    else { *out = p; ok = 1; }
                    goto done;
                }
            }
            buf_puts(err, "URI has neither a d nor a url parameter");
            goto done;
        }
    }

done:
    for (i = 0; i < nparams; i++) { free(params[i].key); free(params[i].value); }
    free(params);
    jval_free(root);
    free(pstr);
    free(qstr);
    free(scheme);
    free(raw);
    return ok;
}

/* ===========================================================================
 * Platform shims: time, paths, files, processes
 * =========================================================================== */

static void utc_now(struct tm *t) {
    time_t now = time(NULL);
#ifdef _WIN32
    gmtime_s(t, &now);
#else
    gmtime_r(&now, t);
#endif
}

static void stamp_compact(char *out, size_t cap) {
    struct tm t;
    utc_now(&t);
    snprintf(out, cap, "%04d%02d%02dT%02d%02d%02dZ",
             t.tm_year + 1900, t.tm_mon + 1, t.tm_mday, t.tm_hour, t.tm_min, t.tm_sec);
}

static void stamp_log(char *out, size_t cap) {
    struct tm t;
    utc_now(&t);
    snprintf(out, cap, "%04d-%02d-%02dT%02d:%02d:%02dZ",
             t.tm_year + 1900, t.tm_mon + 1, t.tm_mday, t.tm_hour, t.tm_min, t.tm_sec);
}

static char *base_dir(void) {
    const char *la = getenv("LOCALAPPDATA");
    if (!la || !*la) {
#ifdef _WIN32
        la = getenv("TEMP");
        if (!la || !*la) la = ".";
#else
        la = getenv("TMPDIR");
        if (!la || !*la) la = "/tmp";
#endif
    }
    return path_join(la, "bingetovlc");
}

static int mkdir_one(const char *path) {
#ifdef _WIN32
    if (CreateDirectoryA(path, NULL)) return 1;
    return GetLastError() == ERROR_ALREADY_EXISTS;
#else
    if (mkdir(path, 0777) == 0) return 1;
    return errno == EEXIST;
#endif
}

static int mkdir_p(const char *path) {
    char *tmp = xstrdup(path);
    size_t i;
    int ok = 1;
    for (i = 1; tmp[i]; i++) {
        if (tmp[i] == '/' || tmp[i] == '\\') {
            char save = tmp[i];
            tmp[i] = '\0';
            if (*tmp && !mkdir_one(tmp)) ok = 0;
            tmp[i] = save;
        }
    }
    if (*tmp && !mkdir_one(tmp)) ok = 0;
    free(tmp);
    return ok;
}

static int file_exists(const char *path) {
#ifdef _WIN32
    DWORD a = GetFileAttributesA(path);
    return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY);
#else
    struct stat st;
    return stat(path, &st) == 0 && S_ISREG(st.st_mode);
#endif
}

static long long file_size(const char *path) {
#ifdef _WIN32
    WIN32_FILE_ATTRIBUTE_DATA d;
    if (GetFileAttributesExA(path, GetFileExInfoStandard, &d))
        return ((long long)d.nFileSizeHigh << 32) | (long long)d.nFileSizeLow;
    return -1;
#else
    struct stat st;
    if (stat(path, &st) == 0) return (long long)st.st_size;
    return -1;
#endif
}

static int write_file(const char *path, const char *data, size_t len) {
#ifdef _WIN32
    HANDLE h = CreateFileA(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    DWORD written = 0;
    BOOL ok;
    if (h == INVALID_HANDLE_VALUE) return 0;
    ok = WriteFile(h, data, (DWORD)len, &written, NULL);
    CloseHandle(h);
    return ok && written == (DWORD)len;
#else
    FILE *f = fopen(path, "wb");
    if (!f) return 0;
    if (len && fwrite(data, 1, len, f) != len) { fclose(f); return 0; }
    fclose(f);
    return 1;
#endif
}

static char *read_file(const char *path, size_t *outlen) {
    FILE *f = fopen(path, "rb");
    long sz;
    char *buf;
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (sz < 0) { fclose(f); return NULL; }
    buf = (char *)xmalloc((size_t)sz + 1);
    if (sz > 0 && fread(buf, 1, (size_t)sz, f) != (size_t)sz) { fclose(f); free(buf); return NULL; }
    fclose(f);
    buf[sz] = '\0';
    if (outlen) *outlen = (size_t)sz;
    return buf;
}

static void delete_file(const char *path) {
#ifdef _WIN32
    DeleteFileA(path);
#else
    remove(path);
#endif
}

static void rename_file(const char *from, const char *to) {
#ifdef _WIN32
    MoveFileA(from, to);
#else
    rename(from, to);
#endif
}

static void rand_hex8(char *out) {
    static int seeded = 0;
    int i;
    if (!seeded) { srand((unsigned)time(NULL) ^ (unsigned)(clock() & 0xffff)); seeded = 1; }
    for (i = 0; i < 8; i++) {
        int v = rand() & 0xF;
        out[i] = "0123456789abcdef"[v];
    }
    out[8] = '\0';
}

static void prune_playlists(const char *dir) {
#ifdef _WIN32
    char pat[4096];
    WIN32_FIND_DATAA fd;
    HANDLE h;
    ULARGE_INTEGER now;
    FILETIME ftnow;
    unsigned long long seven = (unsigned long long)PRUNE_AGE_SECONDS * 10000000ULL;
    GetSystemTimeAsFileTime(&ftnow);
    now.LowPart = ftnow.dwLowDateTime;
    now.HighPart = ftnow.dwHighDateTime;
    snprintf(pat, sizeof(pat), "%s\\*.m3u", dir);
    h = FindFirstFileA(pat, &fd);
    if (h == INVALID_HANDLE_VALUE) return;
    do {
        ULARGE_INTEGER f;
        f.LowPart = fd.ftLastWriteTime.dwLowDateTime;
        f.HighPart = fd.ftLastWriteTime.dwHighDateTime;
        if (now.QuadPart > f.QuadPart && (now.QuadPart - f.QuadPart) > seven) {
            char full[4096];
            snprintf(full, sizeof(full), "%s\\%s", dir, fd.cFileName);
            DeleteFileA(full);
        }
    } while (FindNextFileA(h, &fd));
    FindClose(h);
#else
    DIR *d = opendir(dir);
    struct dirent *e;
    time_t cutoff = time(NULL) - PRUNE_AGE_SECONDS;
    if (!d) return;
    while ((e = readdir(d))) {
        size_t l = strlen(e->d_name);
        if (l > 4 && strcmp(e->d_name + l - 4, ".m3u") == 0) {
            char *full = path_join(dir, e->d_name);
            struct stat st;
            if (stat(full, &st) == 0 && st.st_mtime < cutoff) remove(full);
            free(full);
        }
    }
    closedir(d);
#endif
}

static char *new_playlist_path(const char *dir) {
    char stamp[16], rnd[9], name[64];
    stamp_compact(stamp, sizeof(stamp));
    rand_hex8(rnd);
    snprintf(name, sizeof(name), "bingetovlc-%s-%s.m3u", stamp, rnd);
    return path_join(dir, name);
}

/* ===========================================================================
 * Secret redaction and logging
 *
 * HARD REQUIREMENT: no full URL with a token may ever reach the log. The value
 * of api_key, token and access_token (any case) is replaced with *** on every
 * line written; this mirrors Protect-Secrets in the PowerShell handler.
 * =========================================================================== */

static int value_char(char c) {
    return c != '&' && c != '"' && c != '\'' && !isspace((unsigned char)c);
}

static char *protect_secrets(const char *in) {
    Buf a;
    size_t i, len;
    buf_init(&a);
    if (!in) return buf_detach(&a);
    len = strlen(in);

    /* Pass 1: api_key=... */
    i = 0;
    while (i < len) {
        if (i + 8 <= len && ci_prefix(in + i, "api_key=", 8)) {
            buf_puts(&a, "api_key=");
            i += 8;
            if (i < len && value_char(in[i])) {
                while (i < len && value_char(in[i])) i++;
                buf_puts(&a, "***");
            }
        } else {
            buf_putc(&a, in[i]);
            i++;
        }
    }

    /* Pass 2: any ?/&-parameter whose name contains "token". */
    {
        Buf b;
        const char *s = a.data;
        size_t L = a.len, j = 0;
        buf_init(&b);
        while (j < L) {
            char c = s[j];
            if (c == '?' || c == '&') {
                size_t key_start = j + 1, k = key_start;
                while (k < L) {
                    char d = s[k];
                    if ((d >= 'A' && d <= 'Z') || (d >= 'a' && d <= 'z') || (d >= '0' && d <= '9') || d == '_') k++;
                    else break;
                }
                if (k < L && s[k] == '=' && ci_contains(s + key_start, k - key_start, "token")) {
                    buf_putc(&b, c);
                    buf_putn(&b, s + key_start, k - key_start);
                    buf_putc(&b, '=');
                    j = k + 1;
                    if (j < L && value_char(s[j])) {
                        while (j < L && value_char(s[j])) j++;
                        buf_puts(&b, "***");
                    }
                    continue;
                }
            }
            buf_putc(&b, c);
            j++;
        }
        buf_free(&a);
        return buf_detach(&b);
    }
}

static char *g_logfile = NULL;

static void log_init(void) {
    char *base = base_dir();
    char *logs = path_join(base, "logs");
    char *lf = path_join(logs, "handler.log");
    mkdir_p(logs);
    {
        long long sz = file_size(lf);
        if (sz > LOG_ROTATE_BYTES) {
            char *bak = (char *)xmalloc(strlen(lf) + 3);
            sprintf(bak, "%s.1", lf);
            delete_file(bak);
            rename_file(lf, bak);
            free(bak);
        }
    }
    free(base);
    free(logs);
    g_logfile = lf;
}

static void log_line(const char *msg) {
    char stamp[32];
    char *safe;
    FILE *f;
    if (!g_logfile) return;
    stamp_log(stamp, sizeof(stamp));
    safe = protect_secrets(msg);
    f = fopen(g_logfile, "ab"); /* append binary: UTF-8, LF, no BOM */
    if (f) {
        fputs(stamp, f);
        fputc(' ', f);
        fputs(safe, f);
        fputc('\n', f);
        fclose(f);
    }
    free(safe);
}

/* ===========================================================================
 * VLC discovery
 * =========================================================================== */

#ifdef _WIN32
static char *query_reg_sz(HKEY root, const char *subkey, const char *value) {
    char buf[4096];
    DWORD sz = (DWORD)sizeof(buf);
    DWORD type = 0;
    if (RegGetValueA(root, subkey, value, RRF_RT_REG_SZ, &type, buf, &sz) == ERROR_SUCCESS)
        return xstrdup(buf);
    return NULL;
}
#endif

static char *try_vlc_under(const char *root) {
    char *sub, *exe;
    if (!root || !*root) return NULL;
    sub = path_join(root, "VideoLAN/VLC");
    exe = path_join(sub, "vlc.exe");
    free(sub);
    if (file_exists(exe)) return exe;
    free(exe);
    return NULL;
}

static char *find_vlc(const char *explicit_path) {
    if (explicit_path && *explicit_path) {
        if (file_exists(explicit_path)) return xstrdup(explicit_path);
        return NULL;
    }
    {
        const char *env = getenv("BINGETOVLC_VLC");
        if (env && *env && file_exists(env)) return xstrdup(env);
    }
#ifdef _WIN32
    {
        static const char *keys[2] = {
            "SOFTWARE\\VideoLAN\\VLC",
            "SOFTWARE\\WOW6432Node\\VideoLAN\\VLC"
        };
        int i;
        for (i = 0; i < 2; i++) {
            char *dir = query_reg_sz(HKEY_LOCAL_MACHINE, keys[i], "InstallDir");
            if (dir) {
                char *exe = path_join(dir, "vlc.exe");
                free(dir);
                if (file_exists(exe)) return exe;
                free(exe);
            }
        }
    }
#endif
    {
        char *r = try_vlc_under(getenv("ProgramFiles"));
        if (r) return r;
    }
    {
        char *r = try_vlc_under(getenv("ProgramFiles(x86)"));
        if (r) return r;
    }
    return NULL;
}

/* ===========================================================================
 * Launching VLC and waiting
 * =========================================================================== */

#ifdef _WIN32
static wchar_t *utf8_to_wide(const char *s) {
    int n;
    wchar_t *w;
    if (!s) return NULL;
    n = MultiByteToWideChar(CP_UTF8, 0, s, -1, NULL, 0);
    if (n <= 0) return NULL;
    w = (wchar_t *)xmalloc(sizeof(wchar_t) * (size_t)n);
    MultiByteToWideChar(CP_UTF8, 0, s, -1, w, n);
    return w;
}

static int run_wait_w(const wchar_t *cmdline) {
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    BOOL ok;
    DWORD code = 0;
    memset(&si, 0, sizeof(si));
    si.cb = sizeof(si);
    memset(&pi, 0, sizeof(pi));
    ok = CreateProcessW(NULL, (LPWSTR)cmdline, NULL, NULL, FALSE, 0, NULL, NULL, &si, &pi);
    if (!ok) return -1;
    WaitForSingleObject(pi.hProcess, INFINITE);
    GetExitCodeProcess(pi.hProcess, &code);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return (int)code;
}

static int launch_and_wait(const char *exe, const Payload *p, const char *playlist) {
    Buf cmd;
    char *cs;
    wchar_t *w;
    int rc;
    buf_init(&cmd);
    buf_putc(&cmd, '"');
    buf_puts(&cmd, exe);
    buf_putc(&cmd, '"');
    buf_puts(&cmd, " --started-from-file");
    if (p->opt_fs) buf_puts(&cmd, " --fullscreen");
    if (p->opt_one) buf_puts(&cmd, " --one-instance");
    if (p->opt_exit) buf_puts(&cmd, " --play-and-exit");
    buf_puts(&cmd, " --no-video-title-show ");
    buf_putc(&cmd, '"');
    buf_puts(&cmd, playlist);
    buf_putc(&cmd, '"');
    cs = buf_detach(&cmd);
    w = utf8_to_wide(cs);
    free(cs);
    if (!w) return -1;
    rc = run_wait_w(w);
    free(w);
    return rc;
}
#else
static int launch_and_wait(const char *exe, const Payload *p, const char *playlist) {
    /* Portable test build: no Windows, so exec the given "vlc" directly. */
    char **argv;
    int n = 0, i;
    pid_t pid;
    int st;
    argv = (char **)xmalloc(sizeof(char *) * 8);
    argv[n++] = xstrdup(exe);
    argv[n++] = xstrdup("--started-from-file");
    if (p->opt_fs) argv[n++] = xstrdup("--fullscreen");
    if (p->opt_one) argv[n++] = xstrdup("--one-instance");
    if (p->opt_exit) argv[n++] = xstrdup("--play-and-exit");
    argv[n++] = xstrdup("--no-video-title-show");
    argv[n++] = xstrdup(playlist);
    argv[n] = NULL;
    pid = fork();
    if (pid < 0) {
        for (i = 0; i < n; i++) free(argv[i]);
        free(argv);
        return -1;
    }
    if (pid == 0) { execv(argv[0], argv); _exit(127); }
    waitpid(pid, &st, 0);
    for (i = 0; i < n; i++) free(argv[i]);
    free(argv);
    if (WIFEXITED(st)) return WEXITSTATUS(st);
    return -1;
}
#endif

/* ===========================================================================
 * Handler entry points
 * =========================================================================== */

static int run_selftest(const char *uri) {
    Payload *p = NULL;
    int code = EXIT_MALFORMED;
    Buf err;
    char *m3u;

    buf_init(&err);
    if (!resolve_payload(uri, &p, &code, &err)) {
        fprintf(stderr, "bingetovlc: %s\n", err.data ? err.data : "invalid URI");
        buf_free(&err);
        return code ? code : EXIT_MALFORMED;
    }
    buf_free(&err);

    m3u = build_m3u(p);
    payload_free(p);

#ifdef _WIN32
    _setmode(_fileno(stdout), _O_BINARY);
#endif
    fwrite(m3u, 1, strlen(m3u), stdout);
    fflush(stdout);
    free(m3u);
    return EXIT_OK;
}

static int run_handler(const char *uri, const char *vlcpath, int keep) {
    Payload *p = NULL;
    int code = EXIT_MALFORMED;
    Buf err;
    char *m3u, *base, *pdir, *playlist, *vlc;

    log_init();
    base = base_dir();
    pdir = path_join(base, "playlists");
    mkdir_p(pdir);
    free(base);
    prune_playlists(pdir);

    log_line("handler start (version " HANDLER_VERSION ")");
    if (uri) {
        char *m = (char *)xmalloc(strlen(uri) + 16);
        sprintf(m, "request: %s", uri);
        log_line(m);
        free(m);
    }

    buf_init(&err);
    if (!resolve_payload(uri, &p, &code, &err)) {
        char *m = (char *)xmalloc(strlen(err.data ? err.data : "") + 32);
        sprintf(m, "ERROR URI rejected: %s", err.data ? err.data : "invalid URI");
        log_line(m);
        free(m);
        buf_free(&err);
        free(pdir);
        return code ? code : EXIT_MALFORMED;
    }
    buf_free(&err);

    if (p->has_start) {
        log_line("opts.start is set but is not supported by this handler; starting from the first item");
    }

    m3u = build_m3u(p);

    vlc = find_vlc(vlcpath);
    if (!vlc) {
        log_line("ERROR vlc.exe was not found (pass --vlc or install VLC)");
        free(m3u);
        payload_free(p);
        free(pdir);
        return EXIT_NOVLC;
    }

    playlist = new_playlist_path(pdir);
    if (!write_file(playlist, m3u, strlen(m3u))) {
        char *m = (char *)xmalloc(strlen(playlist) + 48);
        sprintf(m, "ERROR could not write playlist: %s", playlist);
        log_line(m);
        free(m);
        free(m3u);
        free(vlc);
        free(playlist);
        payload_free(p);
        free(pdir);
        return EXIT_WRITE;
    }
    log_line("playlist written");

    {
        int rc = launch_and_wait(vlc, p, playlist);
        if (rc < 0) {
            log_line("ERROR failed to launch vlc");
            free(m3u);
            free(vlc);
            if (keep) log_line("keeping playlist (--keep-playlist)");
            else delete_file(playlist);
            free(playlist);
            payload_free(p);
            free(pdir);
            return EXIT_NOVLC;
        }
    }

    if (keep) {
        log_line("keeping playlist (--keep-playlist)");
    } else {
        delete_file(playlist);
    }

    free(m3u);
    free(vlc);
    free(playlist);
    payload_free(p);
    free(pdir);
    return EXIT_OK;
}

/* ===========================================================================
 * Help and diagnostics
 * =========================================================================== */

static void show_help(void) {
    fputs(
        "bingetovlc-handler -- protocol handler for vlc:// and bingetovlc://.\n"
        "\n"
        "  bingetovlc-handler.exe \"<uri>\"\n"
        "\n"
        "ACCEPTED URIs\n"
        "  vlc://open?d=<base64url json>                 full payload (main form)\n"
        "  bingetovlc://open?d=<base64url json>          same, collision-free alias\n"
        "  vlc://open?url=<encoded abs url>&t=<title>    manual single item\n"
        "  vlc://<absolute url>                          bare convenience form\n"
        "  Scheme case and a trailing slash on \"open\" are tolerated.\n"
        "\n"
        "OPTIONS\n"
        "  --selftest \"<uri>\" decode the URI and print the exact M3U to stdout.\n"
        "                   Launches nothing, touches no registry, needs no\n"
        "                   Windows. This is what CI asserts against the vectors.\n"
        "  --diagnostics    print the VLC path, scheme registration, the playlist\n"
        "                   directory, the last 20 log lines and the user.\n"
        "  --install [--scheme vlc,bingetovlc]\n"
        "                   register the schemes per user in HKCU.\n"
        "  --uninstall      restore the backup of each scheme (or remove the key).\n"
        "  --keep-playlist  keep the generated .m3u after VLC exits (it holds a\n"
        "                   token).\n"
        "  --vlc <path>     explicit path to vlc.exe.\n"
        "  --help           this text.\n"
        "\n"
        "EXIT CODES\n"
        "  0 ok / 2 malformed URI / 3 bad payload / 4 VLC not found / 5 write failure\n",
        stdout);
}

static char *current_user(void);
static void scheme_status(const char *scheme);

static int show_diagnostics(const char *vlcpath) {
    char *base = base_dir();
    char *pdir = path_join(base, "playlists");
    char *ldir = path_join(base, "logs");
    char *lf = path_join(ldir, "handler.log");
    char *user = current_user();
    char *vlc = find_vlc(vlcpath);

    printf("bingetovlc diagnostics\n");
#if LAUNCHER_PORTABLE_TEST
    printf("  build           : portable test build (" __DATE__ ")\n");
#endif
    printf("  handler version : %s\n", HANDLER_VERSION);
    printf("  current user    : %s\n", user);
    if (vlc) printf("  vlc.exe         : %s\n", vlc);
    else printf("  vlc.exe         : NOT FOUND\n");
    scheme_status("vlc");
    scheme_status("bingetovlc");
    printf("  playlist dir    : %s\n", pdir);
    printf("  log file        : %s\n", lf);
    printf("  last 20 log lines:\n");
    {
        size_t len = 0;
        char *text = read_file(lf, &len);
        if (!text) {
            printf("    (no log yet)\n");
        } else {
            size_t nlines = 0, i, start = 0;
            /* count lines */
            for (i = 0; i < len; i++) if (text[i] == '\n') nlines++;
            if (len > 0 && text[len - 1] != '\n') nlines++;
            {
                size_t skip = nlines > 20 ? nlines - 20 : 0, seen = 0;
                for (i = 0; i <= len; i++) {
                    int atnl = (i == len) || text[i] == '\n';
                    if (atnl) {
                        if (i > start) {
                            if (seen >= skip) {
                                fputs("    ", stdout);
                                fwrite(text + start, 1, i - start, stdout);
                                fputc('\n', stdout);
                            }
                            seen++;
                        }
                        start = i + 1;
                    }
                }
            }
            free(text);
        }
    }
    free(base);
    free(pdir);
    free(ldir);
    free(lf);
    free(user);
    free(vlc);
    return EXIT_OK;
}

/* ===========================================================================
 * Install / uninstall (Windows only)
 * =========================================================================== */

#ifdef _WIN32

static void parse_schemes(const char *spec, char names[][32], int *count) {
    const char *s = (spec && *spec) ? spec : "vlc,bingetovlc";
    const char *p = s;
    int n = 0;
    while (*p && n < 8) {
        const char *c = strchr(p, ',');
        size_t l = c ? (size_t)(c - p) : strlen(p);
        if (l > 0 && l < 31) {
            memcpy(names[n], p, l);
            names[n][l] = '\0';
            n++;
        }
        if (!c) break;
        p = c + 1;
    }
    *count = n;
}

static char *current_user(void) {
    char buf[256];
    DWORD n = (DWORD)sizeof(buf);
    if (GetUserNameA(buf, &n)) return xstrdup(buf);
    return xstrdup("?");
}

static char *exe_path(void) {
    char buf[4096];
    DWORD n = GetModuleFileNameA(NULL, buf, (DWORD)sizeof(buf));
    if (n == 0 || n >= sizeof(buf)) return xstrdup("bingetovlc-handler.exe");
    return xstrdup(buf);
}

static void scheme_status(const char *scheme) {
    char sub[512];
    HKEY k;
    snprintf(sub, sizeof(sub), "Software\\Classes\\%s", scheme);
    if (RegOpenKeyExA(HKEY_CURRENT_USER, sub, 0, KEY_READ, &k) != ERROR_SUCCESS) {
        printf("  scheme %-11s: not registered\n", scheme);
        return;
    }
    RegCloseKey(k);
    {
        char csub[512];
        char *cmd;
        snprintf(csub, sizeof(csub), "Software\\Classes\\%s\\shell\\open\\command", scheme);
        cmd = query_reg_sz(HKEY_CURRENT_USER, csub, NULL);
        printf("  scheme %-11s: registered\n", scheme);
        if (cmd) { printf("                     %s\n", cmd); free(cmd); }
    }
}

static int scheme_key_exists(const char *scheme) {
    char sub[512];
    HKEY k;
    snprintf(sub, sizeof(sub), "Software\\Classes\\%s", scheme);
    if (RegOpenKeyExA(HKEY_CURRENT_USER, sub, 0, KEY_READ, &k) == ERROR_SUCCESS) {
        RegCloseKey(k);
        return 1;
    }
    return 0;
}

static int reg_set_string(const char *subkey, const char *name, const char *value) {
    HKEY k;
    DWORD disp;
    LONG r = RegCreateKeyExA(HKEY_CURRENT_USER, subkey, 0, NULL, REG_OPTION_NON_VOLATILE,
                             KEY_WRITE, NULL, &k, &disp);
    if (r != ERROR_SUCCESS) return 0;
    r = RegSetValueExA(k, name, 0, REG_SZ, (const BYTE *)value, (DWORD)(strlen(value) + 1));
    RegCloseKey(k);
    return r == ERROR_SUCCESS;
}

static char *newest_backup(const char *bdir, const char *scheme) {
    char pat[4096];
    WIN32_FIND_DATAA fd;
    HANDLE h;
    char *best = NULL;
    snprintf(pat, sizeof(pat), "%s\\%s-*.reg", bdir, scheme);
    h = FindFirstFileA(pat, &fd);
    if (h == INVALID_HANDLE_VALUE) return NULL;
    do {
        if (!best || strcmp(fd.cFileName, best) > 0) {
            free(best);
            best = xstrdup(fd.cFileName);
        }
    } while (FindNextFileA(h, &fd));
    FindClose(h);
    if (best) {
        char *full = path_join(bdir, best);
        free(best);
        return full;
    }
    return NULL;
}

static int run_cmdline(const char *utf8) {
    wchar_t *w = utf8_to_wide(utf8);
    int rc;
    if (!w) return -1;
    rc = run_wait_w(w);
    free(w);
    return rc;
}

static int install_one(const char *scheme, const char *icon, const char *exe,
                       const char *bdir, int *backed_up) {
    char sub[512], stamp[16];
    char *command;

    if (scheme_key_exists(scheme)) {
        char name[96];
        char *file, *cmdline;
        int rc;
        stamp_compact(stamp, sizeof(stamp));
        snprintf(name, sizeof(name), "%s-%s.reg", scheme, stamp);
        file = path_join(bdir, name);
        mkdir_p(bdir);
        cmdline = (char *)xmalloc(strlen(file) + strlen(scheme) + 96);
        sprintf(cmdline, "reg.exe export \"HKCU\\Software\\Classes\\%s\" \"%s\" /y", scheme, file);
        rc = run_cmdline(cmdline);
        if (rc == 0) {
            printf("  backed up existing %s key -> %s\n", scheme, file);
            *backed_up += 1;
        } else {
            printf("  warning: reg export failed for %s (exit %d)\n", scheme, rc);
        }
        free(cmdline);
        free(file);
    }

    /* default value: a human-readable description of the protocol */
    {
        char desc[128];
        snprintf(sub, sizeof(sub), "Software\\Classes\\%s", scheme);
        snprintf(desc, sizeof(desc), "URL:%s Protocol", scheme);
        reg_set_string(sub, NULL, desc);
        reg_set_string(sub, "URL Protocol", "");
    }
    {
        char iconkey[512];
        snprintf(iconkey, sizeof(iconkey), "Software\\Classes\\%s\\DefaultIcon", scheme);
        reg_set_string(iconkey, NULL, icon);
    }
    command = (char *)xmalloc(strlen(exe) + 16);
    sprintf(command, "\"%s\" \"%%1\"", exe);
    {
        char cmdkey[512];
        snprintf(cmdkey, sizeof(cmdkey), "Software\\Classes\\%s\\shell\\open\\command", scheme);
        reg_set_string(cmdkey, NULL, command);
    }
    printf("  registering %s\n", scheme);
    printf("    key     : HKCU\\Software\\Classes\\%s\n", scheme);
    printf("    command : %s\n", command);
    printf("    icon    : %s\n", icon);
    free(command);
    return 1;
}

static int uninstall_one(const char *scheme, const char *bdir) {
    char *backup = newest_backup(bdir, scheme);
    if (backup) {
        char *cmdline = (char *)xmalloc(strlen(backup) + 32);
        int rc;
        sprintf(cmdline, "reg.exe import \"%s\"", backup);
        rc = run_cmdline(cmdline);
        if (rc == 0) printf("  restored %s from backup: %s\n", scheme, backup);
        else printf("  warning: reg import failed for %s (exit %d)\n", scheme, rc);
        free(cmdline);
        free(backup);
        return 1;
    }
    if (scheme_key_exists(scheme)) {
        char sub[512];
        snprintf(sub, sizeof(sub), "Software\\Classes\\%s", scheme);
        if (RegDeleteTreeA(HKEY_CURRENT_USER, sub) == ERROR_SUCCESS)
            printf("  removed HKCU\\Software\\Classes\\%s (no backup existed)\n", scheme);
        else
            printf("  warning: could not remove HKCU\\Software\\Classes\\%s\n", scheme);
    } else {
        printf("  %s is not registered; nothing to restore or remove.\n", scheme);
    }
    return 1;
}

static void show_scheme_summary(const char *label, char names[][32], int count) {
    int i;
    printf("%s\n", label);
    for (i = 0; i < count; i++) scheme_status(names[i]);
}

static int run_install(const char *schemespec, const char *vlcpath) {
    char names[8][32];
    int count = 0, i, backed_up = 0;
    char *exe = exe_path();
    char *vlc = find_vlc(vlcpath);
    char *base = base_dir();
    char *bdir = path_join(base, "backup");
    char icon[4096];

    parse_schemes(schemespec, names, &count);
    if (vlc) snprintf(icon, sizeof(icon), "\"%s\",0", vlc);
    else icon[0] = '\0';

    if (!vlc) puts("warning: VLC was not found. Registration can still proceed, but VLC must be installed (or --vlc given) before the handler works.");
    else printf("VLC found: %s\n", vlc);

    show_scheme_summary("Before:", names, count);
    mkdir_p(bdir);
    for (i = 0; i < count; i++) install_one(names[i], icon, exe, bdir, &backed_up);
    if (backed_up) printf("  (%d pre-existing scheme key(s) backed up under %s)\n", backed_up, bdir);
    show_scheme_summary("After:", names, count);
    puts("");
    puts("Registration complete. Open a vlc:// link from Chrome/Edge: the browser asks");
    puts("once and remembers your choice for that site. A permanent always-allow for");
    puts("every site needs an enterprise policy (Chrome removed that checkbox in 77).");
    puts("Verify with: bingetovlc-handler.exe --diagnostics");

    if (GetConsoleWindow() == NULL) {
        MessageBoxA(NULL,
                    "bingetovlc is registered for vlc:// and bingetovlc://.\n"
                    "Open a vlc:// link from Chrome or Edge; the browser asks once.",
                    "bingetovlc", MB_OK | MB_ICONINFORMATION);
    }

    free(exe);
    free(vlc);
    free(base);
    free(bdir);
    return EXIT_OK;
}

static int run_uninstall(const char *schemespec) {
    char names[8][32];
    int count = 0, i;
    char *base = base_dir();
    char *bdir = path_join(base, "backup");

    parse_schemes(schemespec, names, &count);
    show_scheme_summary("Before:", names, count);
    for (i = 0; i < count; i++) uninstall_one(names[i], bdir);
    show_scheme_summary("After:", names, count);
    puts("");
    puts("Uninstall complete.");
    free(base);
    free(bdir);
    return EXIT_OK;
}

#else /* not _WIN32 */

static char *current_user(void) {
    const char *u = getenv("USER");
    if (u && *u) return xstrdup(u);
    {
        struct passwd *pw = getpwuid(getuid());
        if (pw && pw->pw_name) return xstrdup(pw->pw_name);
    }
    return xstrdup("?");
}

static void scheme_status(const char *scheme) {
    printf("  scheme %-11s: not registered (not on Windows)\n", scheme);
}

static int run_install(const char *schemespec, const char *vlcpath) {
    (void)schemespec;
    (void)vlcpath;
    fputs("bingetovlc: --install registers protocol handlers in HKCU and is only supported on Windows.\n", stderr);
    return 1;
}

static int run_uninstall(const char *schemespec) {
    (void)schemespec;
    fputs("bingetovlc: --uninstall restores HKCU keys and is only supported on Windows.\n", stderr);
    return 1;
}

#endif /* _WIN32 */

/* ===========================================================================
 * main
 * =========================================================================== */

/*
 * Invoked by hand: a double-click passes no arguments, and the protocol handler
 * always passes a URI. Before this existed a double-click fell through to the URI
 * path, logged "URI rejected: no URI argument was supplied" into the log and
 * exited with code 2 — no window, no registration, while the documentation
 * promised it would install. Reported from a real machine.
 */
#if defined(_WIN32)
static int run_manual(const char *vlcpath) {
    int rc;
    int answer = MessageBoxA(NULL,
        "Register the vlc:// and bingetovlc:// handlers for this user?\n\n"
        "OK     - register them (anything already registered is backed up first)\n"
        "Cancel - change nothing",
        "bingetovlc handler", MB_OKCANCEL | MB_ICONQUESTION);
    if (answer != IDOK) {
        puts("nothing was changed");
        return EXIT_OK;
    }
    rc = run_install(NULL, vlcpath);
    MessageBoxA(NULL,
        rc == EXIT_OK
            ? "Registered. Open a vlc:// link from Chrome or Edge; the browser asks once."
            : "Registration failed. Run the handler with --install in a terminal to see why.",
        "bingetovlc", MB_OK | (rc == EXIT_OK ? MB_ICONINFORMATION : MB_ICONERROR));
    return rc;
}
#else
static int run_manual(const char *vlcpath) {
    (void)vlcpath;
    puts("bingetovlc handler (portable build).");
    puts("Run it with a vlc:// URI, or use --install / --uninstall / --diagnostics / --help.");
    puts("The Windows build opens a confirmation dialog here instead.");
    return EXIT_OK;
}
#endif

int main(int argc, char **argv) {
    int i;
    int selftest = 0, diagnostics = 0, install = 0, uninstall = 0, keep = 0, help = 0;
    const char *uri = NULL, *vlcpath = NULL, *schemespec = NULL;

    for (i = 1; i < argc; i++) {
        const char *a = argv[i];
        if (strcmp(a, "--selftest") == 0) selftest = 1;
        else if (strcmp(a, "--diagnostics") == 0) diagnostics = 1;
        else if (strcmp(a, "--install") == 0) install = 1;
        else if (strcmp(a, "--uninstall") == 0) uninstall = 1;
        else if (strcmp(a, "--keep-playlist") == 0) keep = 1;
        else if (strcmp(a, "--help") == 0 || strcmp(a, "-h") == 0) help = 1;
        else if (strcmp(a, "--vlc") == 0) {
            if (i + 1 < argc) vlcpath = argv[++i];
            else { fputs("bingetovlc: --vlc needs a path\n", stderr); return EXIT_MALFORMED; }
        } else if (strncmp(a, "--vlc=", 6) == 0) vlcpath = a + 6;
        else if (strcmp(a, "--scheme") == 0) {
            if (i + 1 < argc) schemespec = argv[++i];
            else { fputs("bingetovlc: --scheme needs a value\n", stderr); return EXIT_MALFORMED; }
        } else if (strncmp(a, "--scheme=", 9) == 0) schemespec = a + 9;
        else if (a[0] == '-' && a[1] == '-') {
            fprintf(stderr, "bingetovlc: unknown option %s\n", a);
            return EXIT_MALFORMED;
        } else uri = a;
    }

    if (help) { show_help(); return EXIT_OK; }
    if (install) return run_install(schemespec, vlcpath);
    if (uninstall) return run_uninstall(schemespec);
    if (selftest) return run_selftest(uri);
    if (diagnostics) return show_diagnostics(vlcpath);
    /* No URI and no action asked for: a double-click, not a hand-off. */
    if (!uri) return run_manual(vlcpath);
    return run_handler(uri, vlcpath, keep);
}
