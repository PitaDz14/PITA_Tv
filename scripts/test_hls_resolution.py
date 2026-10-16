#!/usr/bin/env python3
import unittest
from update_streams import master_playlist_children, resolve_child_playlist_url

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
