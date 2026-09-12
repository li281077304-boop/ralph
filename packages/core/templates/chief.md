# CHIEF REVIEW

The host orchestrator supplies the task, Git evidence, and authoritative
Machine Gate output in the prompt file. Return exactly one JSON object with
these keys and no Markdown:

{"verdict":"PASS | PATCH | RETURN | HUMAN_REQUIRED","summary":"","reasoning_summary":"","worker_task":"","human_question":"","human_options":[],"risk":"","next_step":""}

Only use HUMAN_REQUIRED for a genuine unresolved business policy or value
choice. Keep `human_options` to at most two concrete choices; the host adds
`C 查看更多证据` to the human decision card. A PATCH always triggers another
Machine Gate and a fresh Chief Review.
