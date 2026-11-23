"""
فكّ تشفير AES-CBC بـ Python خالص — بلا أي مكتبة خارجية.

لماذا بلا مكتبة: المستخرج يعمل داخل GitHub Actions على مصادر `kind=crypt`،
وإضافة تبعية (pycryptodome/cryptography) تعني احتمال فشل تثبيت على منصّة
أو نسخة Python مختلفة. الخوارزمية ثابتة ومعروفة، وتنفيذها هنا مغطّى باختبارات
تقارنه بمكتبة `cryptography` المرجعية (انظر test_aes_cbc.py).

يدعم: AES-128/192/256 (حسب طول المفتاح)، وضع CBC، وحشو PKCS#7.
"""

from __future__ import annotations

# --- جداول AES الثابتة (FIPS-197) ---------------------------------------------

SBOX = [
    0x63, 0x7C, 0x77, 0x7B, 0xF2, 0x6B, 0x6F, 0xC5, 0x30, 0x01, 0x67, 0x2B, 0xFE, 0xD7, 0xAB, 0x76,
    0xCA, 0x82, 0xC9, 0x7D, 0xFA, 0x59, 0x47, 0xF0, 0xAD, 0xD4, 0xA2, 0xAF, 0x9C, 0xA4, 0x72, 0xC0,
    0xB7, 0xFD, 0x93, 0x26, 0x36, 0x3F, 0xF7, 0xCC, 0x34, 0xA5, 0xE5, 0xF1, 0x71, 0xD8, 0x31, 0x15,
    0x04, 0xC7, 0x23, 0xC3, 0x18, 0x96, 0x05, 0x9A, 0x07, 0x12, 0x80, 0xE2, 0xEB, 0x27, 0xB2, 0x75,
    0x09, 0x83, 0x2C, 0x1A, 0x1B, 0x6E, 0x5A, 0xA0, 0x52, 0x3B, 0xD6, 0xB3, 0x29, 0xE3, 0x2F, 0x84,
    0x53, 0xD1, 0x00, 0xED, 0x20, 0xFC, 0xB1, 0x5B, 0x6A, 0xCB, 0xBE, 0x39, 0x4A, 0x4C, 0x58, 0xCF,
    0xD0, 0xEF, 0xAA, 0xFB, 0x43, 0x4D, 0x33, 0x85, 0x45, 0xF9, 0x02, 0x7F, 0x50, 0x3C, 0x9F, 0xA8,
    0x51, 0xA3, 0x40, 0x8F, 0x92, 0x9D, 0x38, 0xF5, 0xBC, 0xB6, 0xDA, 0x21, 0x10, 0xFF, 0xF3, 0xD2,
    0xCD, 0x0C, 0x13, 0xEC, 0x5F, 0x97, 0x44, 0x17, 0xC4, 0xA7, 0x7E, 0x3D, 0x64, 0x5D, 0x19, 0x73,
    0x60, 0x81, 0x4F, 0xDC, 0x22, 0x2A, 0x90, 0x88, 0x46, 0xEE, 0xB8, 0x14, 0xDE, 0x5E, 0x0B, 0xDB,
    0xE0, 0x32, 0x3A, 0x0A, 0x49, 0x06, 0x24, 0x5C, 0xC2, 0xD3, 0xAC, 0x62, 0x91, 0x95, 0xE4, 0x79,
    0xE7, 0xC8, 0x37, 0x6D, 0x8D, 0xD5, 0x4E, 0xA9, 0x6C, 0x56, 0xF4, 0xEA, 0x65, 0x7A, 0xAE, 0x08,
    0xBA, 0x78, 0x25, 0x2E, 0x1C, 0xA6, 0xB4, 0xC6, 0xE8, 0xDD, 0x74, 0x1F, 0x4B, 0xBD, 0x8B, 0x8A,
    0x70, 0x3E, 0xB5, 0x66, 0x48, 0x03, 0xF6, 0x0E, 0x61, 0x35, 0x57, 0xB9, 0x86, 0xC1, 0x1D, 0x9E,
    0xE1, 0xF8, 0x98, 0x11, 0x69, 0xD9, 0x8E, 0x94, 0x9B, 0x1E, 0x87, 0xE9, 0xCE, 0x55, 0x28, 0xDF,
    0x8C, 0xA1, 0x89, 0x0D, 0xBF, 0xE6, 0x42, 0x68, 0x41, 0x99, 0x2D, 0x0F, 0xB0, 0x54, 0xBB, 0x16,
]

INV_SBOX = [0] * 256
for _i, _v in enumerate(SBOX):
    INV_SBOX[_v] = _i

RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1B, 0x36,
        0x6C, 0xD8, 0xAB, 0x4D, 0x9A]

BLOCK = 16


def _xtime(a: int) -> int:
    a <<= 1
    if a & 0x100:
        a ^= 0x11B
    return a & 0xFF


def _mul(a: int, b: int) -> int:
    """ضرب في حقل جالوا GF(2^8)."""
    r = 0
    while b:
        if b & 1:
            r ^= a
        a = _xtime(a)
        b >>= 1
    return r


def _expand_key(key: bytes) -> list[list[int]]:
    """توسيع المفتاح إلى Nr+1 مفاتيح دائرية، كل منها 16 بايت كـ 4 كلمات."""
    nk = len(key) // 4
    if nk not in (4, 6, 8):
        raise ValueError(f"طول مفتاح AES غير مدعوم: {len(key)} بايت")
    nr = nk + 6
    w = [list(key[4 * i:4 * i + 4]) for i in range(nk)]
    for i in range(nk, 4 * (nr + 1)):
        temp = list(w[i - 1])
        if i % nk == 0:
            temp = temp[1:] + temp[:1]                       # RotWord
            temp = [SBOX[b] for b in temp]                   # SubWord
            temp[0] ^= RCON[i // nk - 1]
        elif nk > 6 and i % nk == 4:
            temp = [SBOX[b] for b in temp]
        w.append([w[i - nk][j] ^ temp[j] for j in range(4)])
    rounds = []
    for r in range(nr + 1):
        rk = []
        for c in range(4):
            rk.extend(w[4 * r + c])
        rounds.append(rk)
    return rounds


def _inv_shift_rows(s: list[int]) -> None:
    # الحالة مخزّنة عموديًا: s[c*4 + r]
    for r in range(1, 4):
        row = [s[c * 4 + r] for c in range(4)]
        row = row[-r:] + row[:-r]
        for c in range(4):
            s[c * 4 + r] = row[c]


def _inv_mix_columns(s: list[int]) -> None:
    for c in range(4):
        a = s[c * 4:c * 4 + 4]
        s[c * 4 + 0] = _mul(a[0], 14) ^ _mul(a[1], 11) ^ _mul(a[2], 13) ^ _mul(a[3], 9)
        s[c * 4 + 1] = _mul(a[0], 9) ^ _mul(a[1], 14) ^ _mul(a[2], 11) ^ _mul(a[3], 13)
        s[c * 4 + 2] = _mul(a[0], 13) ^ _mul(a[1], 9) ^ _mul(a[2], 14) ^ _mul(a[3], 11)
        s[c * 4 + 3] = _mul(a[0], 11) ^ _mul(a[1], 13) ^ _mul(a[2], 9) ^ _mul(a[3], 14)


def _decrypt_block(block: bytes, rkeys: list[list[int]]) -> bytes:
    s = list(block)
    nr = len(rkeys) - 1
    for i in range(16):
        s[i] ^= rkeys[nr][i]
    for rnd in range(nr - 1, 0, -1):
        _inv_shift_rows(s)
        s = [INV_SBOX[b] for b in s]
        for i in range(16):
            s[i] ^= rkeys[rnd][i]
        _inv_mix_columns(s)
    _inv_shift_rows(s)
    s = [INV_SBOX[b] for b in s]
    for i in range(16):
        s[i] ^= rkeys[0][i]
    return bytes(s)


def _unpad_pkcs7(data: bytes) -> bytes:
    if not data or len(data) % BLOCK:
        raise ValueError("طول النص المشفّر ليس من مضاعفات 16")
    n = data[-1]
    if not 1 <= n <= BLOCK:
        raise ValueError(f"حشو PKCS#7 غير صالح (قيمة {n})")
    if data[-n:] != bytes([n]) * n:
        raise ValueError("حشو PKCS#7 غير صالح (البايتات لا تطابق)")
    return data[:-n]


def decrypt_cbc(ciphertext: bytes, key: bytes, iv: bytes, unpad: bool = True) -> bytes:
    """فكّ تشفير AES-CBC. يرفع ValueError عند مدخلات غير صالحة."""
    if len(iv) != BLOCK:
        raise ValueError(f"طول IV يجب أن يكون 16 بايت، وليس {len(iv)}")
    if len(ciphertext) % BLOCK:
        raise ValueError("طول النص المشفّر ليس من مضاعفات 16")
    rkeys = _expand_key(key)
    out = bytearray()
    prev = iv
    for off in range(0, len(ciphertext), BLOCK):
        chunk = ciphertext[off:off + BLOCK]
        dec = _decrypt_block(chunk, rkeys)
        out.extend(a ^ b for a, b in zip(dec, prev))
        prev = chunk
    return _unpad_pkcs7(bytes(out)) if unpad else bytes(out)


def decrypt_text(ciphertext: bytes, key: bytes, iv: bytes, encoding: str = "utf-8") -> str:
    """فكّ التشفير وإرجاع نص — الاستخدام المعتاد (رابط البث)."""
    return decrypt_cbc(ciphertext, key, iv).decode(encoding, "replace")
