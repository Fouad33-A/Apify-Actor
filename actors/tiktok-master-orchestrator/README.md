# TikTok Master Pipeline
One Apify Actor orchestrating existing Creator Search, Profile & Video Stats, and Comments Actors.

Actor IDs: Creator Search `ABXXVWJ3VcAlhLYnL`, Profile `6HRoM9FvmfZjTfdFw`, Comments `3QDFPIaSngyuNE8Il`.

Default pilot: five qualifying creators, up to five videos per creator, 100 comments per video. The master invokes child Actors and **incurs their usage charges**. Do not run until explicitly approved.

The master fails safely when discovery finds no qualifying creators or when no creator has at least two usable videos. It emits `PIPELINE_SUMMARY` with child run IDs and qualifying repeated questions. Child datasets remain available separately.

Known limits: Creator Search discovery may fail due to blocked sources; public profile source has at most 10 recent videos rather than 30; top-level comments only; semantic clustering is conservative heuristics.

Offline test: `node test-pipeline.mjs`.
