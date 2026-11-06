#!/usr/bin/env python3
"""
اختبارات فكّ تشفير AES-CBC الخالص (scripts/aes_cbc.py).

مستويان من الثقة:
1. متجهات FIPS-197 الرسمية — تعمل دائمًا بلا أي تبعية.
2. مقارنة مباشرة بمكتبة `cryptography` المرجعية — تُتخطّى تلقائيًا إن لم تكن مثبّتة.
"""
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from aes_cbc import decrypt_cbc, decrypt_text  # noqa: E402


class FipsVectors(unittest.TestCase):
    """متجهات FIPS-197 (الملحق C) — مفتاح 128/192/256 على نفس النص."""

    PLAIN = bytes.fromhex("00112233445566778899aabbccddeeff")
    CIPHERS = {
        16: ("000102030405060708090a0b0c0d0e0f",
             "69c4e0d86a7b0430d8cdb78070b4c55a"),
        24: ("000102030405060708090a0b0c0d0e0f1011121314151617",
             "dda97ca4864cdfe06eaf70a0ec0d7191"),
        32: ("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
             "8ea2b7ca516745bfeafc49904b496089"),
    }

    def test_official_vectors(self):
        for size, (key_hex, ct_hex) in self.CIPHERS.items():
            key = bytes.fromhex(key_hex)
            ct = bytes.fromhex(ct_hex)
            # نص واحد كتلة بالضبط → نفكّ بلا إزالة حشو
            self.assertEqual(decrypt_cbc(ct, key, b"\x00" * 16, unpad=False),
                             self.PLAIN, f"AES-{size * 8} فشل")


class PaddingTests(unittest.TestCase):
    def test_pkcs7_roundtrip_padding(self):
        # 16 بايت → كتلة حشو كاملة
        key = os.urandom(32)
        iv = os.urandom(16)
        data = b"https://x/y.m3u8"
        from aes_cbc import _expand_key, _decrypt_block  # noqa: F401
        # نصنع النص المشفّر يدويًا بـ CBC عبر تشفير مرجعي إن توفّر، وإلا نتخطّى
        try:
            from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        except ImportError:
            self.skipTest("cryptography غير مثبّتة")
        enc = Cipher(algorithms.AES(key), modes.CBC(iv)).encryptor()
        padded = data + bytes([16 - len(data) % 16]) * (16 - len(data) % 16)
        ct = enc.update(padded) + enc.finalize()
        self.assertEqual(decrypt_cbc(ct, key, iv), data)

    def test_bad_padding_rejected(self):
        key = os.urandom(16)
        iv = os.urandom(16)
        with self.assertRaises(ValueError):
            decrypt_cbc(b"\x00" * 16, key, iv)   # حشو صفري غير صالح


class BadInputTests(unittest.TestCase):
    def test_iv_length_checked(self):
        with self.assertRaises(ValueError):
            decrypt_cbc(b"\x00" * 16, b"\x00" * 16, b"\x00" * 8)

    def test_key_length_checked(self):
        with self.assertRaises(ValueError):
            decrypt_cbc(b"\x00" * 16, b"\x00" * 20, b"\x00" * 16)

    def test_ciphertext_block_checked(self):
        with self.assertRaises(ValueError):
            decrypt_cbc(b"\x00" * 17, b"\x00" * 16, b"\x00" * 16)


class AgainstReferenceLibrary(unittest.TestCase):
    """مقارنة مباشرة بمكتبة cryptography على مدخلات عشوائية."""

    def setUp(self):
        try:
            from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
            from cryptography.hazmat.primitives import padding as sympad
        except ImportError:
            self.skipTest("cryptography غير مثبّتة")
        self.Cipher, self.algorithms, self.modes, self.sympad = Cipher, algorithms, modes, sympad

    def _ref_encrypt(self, data: bytes, key: bytes, iv: bytes) -> bytes:
        padder = self.sympad.PKCS7(128).padder()
        padded = padder.update(data) + padder.finalize()
        enc = self.Cipher(self.algorithms.AES(key), self.modes.CBC(iv)).encryptor()
        return enc.update(padded) + enc.finalize()

    def test_random_roundtrips_all_key_sizes(self):
        for size in (16, 24, 32):
            for n in (1, 15, 16, 17, 100, 1000):
                data = os.urandom(n)
                key, iv = os.urandom(size), os.urandom(16)
                ct = self._ref_encrypt(data, key, iv)
                self.assertEqual(decrypt_cbc(ct, key, iv), data,
                                 f"AES-{size * 8}, {n} بايت")

    def test_decrypts_realistic_stream_url(self):
        url = ("https://ruyas.store/fajer1/index.m3u8?token="
               "11e1fa3dcbe8754e6bc71767ebc314d9e55414e6-1a049f4d01ba50697270e29a21482d23-1792184325-1792182525")
        key, iv = os.urandom(32), os.urandom(16)
        ct = self._ref_encrypt(url.encode(), key, iv)
        self.assertEqual(decrypt_text(ct, key, iv), url)


if __name__ == "__main__":
    unittest.main(verbosity=2)
