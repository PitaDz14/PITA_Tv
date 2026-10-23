#!/usr/bin/env python3
import sys
import unittest
from pathlib import Path

# يعمل من أي مجلد تشغيل (جذر المستودع أو scripts/)
sys.path.insert(0, str(Path(__file__).resolve().parent))

from update_streams import (  # noqa: E402
    Candidate,
    master_playlist_children,
    playlist_preference_score,
    resolve_child_playlist_url,
    score_candidate,
)


class AudioOnlyVariantTests(unittest.TestCase):
    """
    مسار الصوت فقط (tracks-a1) يجب ألا يفوز على مسار الفيديو (tracks-v1a1).
    اختياره يعطي صورة سوداء مع صوت — عيب ظهر فعليًا في Alfajer TV 1.
    """

    def test_video_variant_outranks_audio_only(self):
        a1 = Candidate(url="https://x/fajer1/tracks-a1/mono.m3u8", origin="request", order=5, status=200)
        v1a1 = Candidate(url="https://x/fajer1/tracks-v1a1/mono.m3u8", origin="request", order=1, status=200)
        self.assertGreater(score_candidate(v1a1), score_candidate(a1))
        self.assertGreater(playlist_preference_score(v1a1.url), playlist_preference_score(a1.url))

    def test_master_prefers_video_child(self):
        master = """#EXTM3U
#EXT-X-STREAM-INF:RESOLUTION=1024x576
tracks-v1a1/mono.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=130000,CODECS=""
tracks-a1/mono.m3u8
"""
        kids = master_playlist_children(master, "https://x/fajer1/index.m3u8")
        self.assertTrue(kids, "يجب أن نجد مسارات فرعية")
        self.assertIn("tracks-v1a1", kids[0], f"الأولوية للفيديو، لكن جاء: {kids}")

    def test_audio_only_detected_in_paths(self):
        from update_streams import AUDIO_ONLY_RE
        self.assertTrue(AUDIO_ONLY_RE.search("/fajer1/tracks-a1/mono.m3u8"))
        self.assertFalse(AUDIO_ONLY_RE.search("/fajer1/tracks-v1a1/mono.m3u8"))

MASTER = """#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=1200000
tracks-v1a1/mono.m3u8
"""

MEDIA = """#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:1
#EXTINF:6,
segment1.ts
"""

class HlsResolutionTests(unittest.TestCase):
    def test_all_alfajer_channels_resolve_to_mono_and_keep_token(self):
        for n in range(1, 6):
            with self.subTest(channel=n):
                parent = f"https://ruyas.store/fajer{n}/index.m3u8?token=token-{n}"
                children = master_playlist_children(
                    MASTER,
                    parent,
                    ["tracks-v1a1/mono.m3u8", "mono.m3u8"],
                )
                self.assertEqual(
                    children,
                    [f"https://ruyas.store/fajer{n}/tracks-v1a1/mono.m3u8?token=token-{n}"],
                )

    def test_child_query_wins_over_parent_query(self):
        parent = "https://ruyas.store/fajer2/index.m3u8?token=parent"
        child = resolve_child_playlist_url(parent, "tracks-v1a1/mono.m3u8?token=child")
        self.assertEqual(
            child,
            "https://ruyas.store/fajer2/tracks-v1a1/mono.m3u8?token=child",
        )

    def test_token_is_not_leaked_to_other_host(self):
        parent = "https://ruyas.store/fajer3/index.m3u8?token=secret"
        child = resolve_child_playlist_url(parent, "https://cdn.example/live/mono.m3u8")
        self.assertEqual(child, "https://cdn.example/live/mono.m3u8")

    def test_media_playlist_has_no_children(self):
        parent = "https://ruyas.store/fajer4/tracks-v1a1/mono.m3u8?token=x"
        self.assertEqual(master_playlist_children(MEDIA, parent), [])

    def test_preference_beats_master_order(self):
        body = """#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000
other/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1200000
tracks-v1a1/mono.m3u8
"""
        parent = "https://ruyas.store/fajer5/index.m3u8?token=x"
        children = master_playlist_children(body, parent, ["tracks-v1a1/mono.m3u8"])
        self.assertTrue(children[0].endswith("/tracks-v1a1/mono.m3u8?token=x"))

if __name__ == "__main__":
    unittest.main(verbosity=2)
