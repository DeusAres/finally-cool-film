# Gold 200 / Frontier reference data: FINDINGS

## Result: 0 images accepted, 0 measured. No numbers produced.
- WebSearch returned only text sources. No ColorChecker/grey-card or side-by-side Gold 200 Frontier scan was found.
- Every image host tried (lab blogs, Flickr, Reddit, Imgur, Wikimedia, Lomography, Photrio, Substack) was blocked by the sandbox proxy (CONNECT 403). WebFetch failed with ENOTFOUND.
- Nothing was padded or estimated. Per the rules, the spec is unchanged.

## Spec field -> current -> evidence-based -> confidence
| field | current | evidence-based | confidence |
|---|---|---|---|
| all grey/cc24/global | expert priors (SPEC.md) | no change; no measurements | n/a |

## Qualitative text only (not measurements)
- A Frontier vs Noritsu write-up (jbflanc.substack.com) shows unedited Gold 200 scans. It calls the Frontier punchy and warm with crushed shadows. This is consistent with the spec's priors.
- A Lomography user reports Frontier SP-3000 Gold 200 scans as "very neutral". Another user reports saturated ones. A Photrio thread (Frontier 330, default settings) calls Gold "warm but muddy". Operator and AutoSetup variance is large.
- Together these argue for keeping the grey cast ranges wide (b* -1..+9 mid). They do not support tightening.

## Next step
Re-run with an allowlist covering image hosts, or supply local files. Procedure and measurement plan are as in the task brief.
