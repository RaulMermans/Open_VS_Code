M2 rc.18 visual review — NOT AUTO-APPROVED

Source: packaged CDP 2026-11-13T08-51-11-683Z on /tmp/ovsc-rc18
Narrow sample: 2026-11-13T08-54-50-852Z (OPEN_VS_CODE_ACCEPTANCE_WINDOW_SIZE=1100,800)
Installed daily driver remains 0.1.0-rc.16. This candidate is not installed.

Objective GUI checks already ran. These copies are for human visual sign-off.
Do not treat this directory as visual PASS.

before/ is the rc.17 reject set.
after/ is the rc.18 packaged payload after companion-sidebar and output collapse.

02 wider chat            UX-WIDE/wide-open.png
03 activity timeline     UX-ACTIVITY/after-prompt.png
04 proposed diff         UX-DIFF/review.png
05 rejected diff         UX-DIFF/after-prompt.png
06 completed verified    CODE-BUG/after-prompt.png
07 restored conversation LIFE-HISTORY/after-prompt.png
08 reject confirmation   SAFE-REJECT/after-prompt.png
09 wider chat narrow     UX-WIDE/wide-open.png (1100×800 requested)

Remaining visual notes for a person:
- Empty editor welcome still dominates coding tasks that do not open a file.
- Completed outcome card can sit above the visible transcript while activity and the command card fill the sidebar.
- Electron may ignore --window-size; confirm 09 is actually narrower on disk.
