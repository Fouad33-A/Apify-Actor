TikTok Profile & Video Stats Actor — Fix package

IMPORTANT: This ZIP is a PATCH PACKAGE, not a complete Apify Actor upload.
It contains a script that edits the existing Actor source file in your GitHub repository.
It does NOT change the separate TikTok Creator Search Actor.

1. In GitHub, open Fouad33-A/Apify-Actor and switch to branch:
   fix/tiktok-creator-search-nov3
2. Click Code > Download ZIP and extract the repository.
3. Extract this patch ZIP too.
4. Open a terminal in the extracted repository's top-level directory.
5. Run:
   python path/to/apply_actor_fixes.py .
   (On Windows, "py path\\to\\apply_actor_fixes.py ." may work.)
6. Review changes to actors/tiktok-profile-video-stats/src/main.ts.
7. Commit/push the changed main.ts to the same GitHub branch, or have Claude do so.
8. Rebuild the Apify Actor and test it.

Changes:
- postsPerWeek = (number of valid sampled timestamps - 1) * 7 / days
  between newest and oldest sampled timestamps.
- selling uses commerce signals in the bio, commerce link domains,
  and TikTok shop/commerce flags. Sponsored/ad flags are separate.
- Adds sponsored and sponsoredSignals fields to the selling analysis.
- Keeps median plays, followers, and top-10 comment ranking unchanged.

CAUTION: Source changes have not been compiled or run in Apify yet.
