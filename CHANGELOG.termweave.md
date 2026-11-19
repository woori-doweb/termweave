# TermWeave Changelog

TermWeave(herdr web ui 포크)의 변경 기록입니다. 원본 프로젝트의 기록은 `CHANGELOG.md`에 있습니다.
이 파일에는 실제 동작이나 게이트로 확인된 완료 항목만 적습니다. 일부만 끝난 항목은 "남은 일"에 따로 적습니다.

## [0.3.43] - 2026-11-12

- 바이오닉 리딩이 한국어에서도 확실히 보이도록 고쳤습니다. 한글 글꼴은 굵게 해도 차이가 작아서, 이제 단어 앞부분은 굵게, 나머지는 흐리게 표시합니다(예: **바이**오닉 **리딩**은). Claude Code처럼 글자에 색을 입혀 출력하는 프로그램에서도 효과가 나타나도록 함께 고쳤습니다.

## [0.3.42] - 2026-11-12

- 새 버전이 있으면 화면 위쪽 헤더의 '채팅/터미널' 전환 버튼 왼쪽에 'vX.Y.Z으로 업데이트' 버튼이 나타납니다. 누르면 바로 새 버전을 설치하고 다시 시작하며, 진행 중에는 '업데이트 중…'으로 표시됩니다. 최신 버전이면 버튼이 보이지 않습니다. 기존에 헤더 아래에 뜨던 알림 막대는 이 버튼으로 바뀌었습니다.

## [0.3.41] - 2026-11-12

- 설정 › 터미널에 '바이오닉 리딩' 스위치를 추가했습니다. 켜면 실시간으로 나오는 모든 터미널 글자에서 단어 앞부분이 굵게 표시되어 빠르게 훑어 읽을 수 있습니다(예: **안녕**하세요, **rea**ding). 한국어도 적용되고, 글자 색과 화면 배치는 그대로입니다. 화면 표시만 바뀌므로 복사한 글자와 프로그램에 전달되는 내용은 달라지지 않습니다. 켠 뒤에 새로 출력되는 글자부터 적용됩니다.

## [0.3.40] - 2026-11-12

- 다른 분들이 설치한 TermWeave도 새 버전이 나오면 앱 위쪽에 업데이트 알림이 뜹니다. 6시간마다 GitHub 릴리스를 확인하고, '업데이트 보기' → '업데이트 후 재시작' 버튼을 누르면 새 버전을 받아 설치한 뒤 다시 시작합니다. 새 버전이 응답하지 않으면 이전 버전으로 자동으로 되돌립니다. 터미널 세션과 설정은 그대로 유지됩니다. (scripts/install.sh로 설치한 경우에 적용됩니다.)

## [0.3.39] - 2026-11-12

- 터미널 위 탭(예: 'P13 goat-si/goat 저장소 리뷰')을 마우스 오른쪽 버튼으로 누르면 이름 변경 창이 바로 열립니다. 지금 이름이 미리 채워져 있어서 고친 뒤 '이름 바꾸기'를 누르면 됩니다. 사이드바에도 같은 이름이 반영됩니다.

## [0.3.38] - 2026-11-12

- 지금 작업 중인 작업 공간을 강하게 강조합니다. 사이드바에서는 열린 작업 공간 블록 전체를 테두리로 감싸고 '현재' 표시를 붙입니다. 터미널 위 헤더에도 작업 공간 이름이 강조되어 나옵니다. 설정 › 화면 › '현재 작업 공간 강조'에서 끌 수 있습니다.

## [0.3.37] - 2026-11-12

- '에이전트 현황' 맨 위에 '에이전트 연결도'를 추가했습니다. PC → 프로젝트 → P 번호 → 에이전트 순서로 선이 이어지고, 대기 중인 에이전트까지 모두 보입니다. 줄을 누르면 그 터미널이 바로 열립니다.

## [0.3.36] - 2026-11-11

- fix(layout): give the terminal the height at every width

## [0.3.35] - 2026-11-11

- fix(security): close the open CodeQL alerts in shipped code
- fix(appearance): draw Chinese and Japanese in their own fonts

## [0.3.34] - 2026-11-09

- feat(fleet): port GOAT's whole Fleet page: heat, telemetry console, pullable graph

## [0.3.33] - 2026-11-09

- fix(fleet,wait,ws): settle waits on this turn; keep jitter and backoff on wake
- feat(pane-context): wait until a P-number's agent stops working
- fix(ws): jitter reconnects, back off on flaps, retry at once on return
- feat(fleet): show every PC and its agents on one orbit map
- fix(operations): validate Unix socket paths without realpath on sockets
- feat(operations): verify isolated recovery before production activation
- feat(projects): create project folders and preserve live fixes

## [0.3.32] - 2026-11-05

- feat(projects): create and select an empty project folder from the folder browser, including remote PCs.
- fix(layout): preserve existing pane layout and include newly available workspace panes.
- fix(prompt): submit custom Claude plan feedback with Enter.
- fix(codex): retain conversation identity while transient child processes appear and exit.
- fix(mesh): reduce socket identity probe overhead and preserve the roster hook's shared time budget.
- test(updater): avoid repeated macOS Git discovery overhead without changing test deadlines.

## [0.3.31] - 2026-10-31

- feat(mobile): attach photos from the phone's terminal line

## [0.3.30] - 2026-10-31

- feat(mobile): fold the header tools behind one button on phones
- fix(mobile): give the terminal the phone's height
- feat(sidebar): add nested team folders and align split headers

## [0.3.29] - 2026-10-28

- fix(resurrect): keep a failed restore pending and add retry

## [0.3.28] - 2026-10-26

- fix(mobile): send the line when Send is tapped while the IME still composes

## [0.3.27] - 2026-10-23

- fix(resurrect): resume proxied agents through their wrapper, never as plain claude

## [0.3.26] - 2026-10-22

- fix(test): wait for the status event instead of a fixed tick in collector recovery

## [0.3.25] - 2026-10-22

- fix(workspaces): share folder colors through the server and push folder changes live
- fix(windows): accept state files without POSIX modes or uid, add PR triage and Windows CI

## [0.3.24] - 2026-10-22

- feat(install): one-command installer and an AGENTS.md guide so an AI agent can set TermWeave up from the repo

## [0.3.23] - 2026-10-22

- feat(sidebar): pick any folder color with a palette or a HEX code

## [0.3.22] - 2026-10-21

- feat(settings): Aside-style settings with a section nav and search; keep the bell when alerts are blocked

## [0.3.21] - 2026-10-21

- fix(terminal): keep agent text readable in light mode

## [0.3.20] - 2026-10-19

- feat(sidebar): reorder terminals inside one tab by dragging or Move up/down

## [0.3.19] - 2026-10-19

- feat(sidebar): move a terminal to another folder from its menu or by dragging

## [0.3.18] - 2026-10-19

- feat(showcase): add a real-screen feature tour to the README

## [0.3.17] - 2026-10-19

- fix(ownership): pass on expired claims left by a restarted herdr server

## [0.3.16] - 2026-10-19

- fix(ownership): pass an expired claim on only when its owner terminal is gone

## [0.3.15] - 2026-10-19

- feat(appearance): pick custom colors with a Photoshop-style color picker

## [0.3.14] - 2026-10-19

- fix(ux): an ended terminal offers no next step, and two processes starting the claim store could fail

## [0.3.13] - 2026-10-19

- fix(pane-mesh): a reused P-number could be read as the old pane, and the roster's commands failed when copied

## [0.3.12] - 2026-10-19

- fix(server): bound queued pane input and stop a stuck teardown from blocking a pane

## [0.3.11] - 2026-10-19

- fix(terminal): keystrokes could reach a pane other than the selected one
- fix(test): assemble the credential URL fixture at run time
- fix(release): take the unfinished privacy scan out of the export

## [0.3.10] - 2026-10-19

- fix(release): scan the public export for private data before history is written
- fix(mobile): cancel delayed terminal focus when the sidebar or a portal menu is used
- feat(workspaces): drag a workspace with preview displacement and drop settling
- fix(panes): reuse the smallest free pane number and look up pane context by P-number

## [0.3.9] - 2026-10-10

- fix(android): installer status could be forged by another app; harden auto release

## [0.3.8] - 2026-10-09

- fix(android): companion app crashed on launch when scheduling the update check

## [0.3.7] - 2026-10-09

- feat(android): companion APK checks the relay for new versions and installs them

## [0.3.6] - 2026-10-09

- fix: TermWeave name in connect and update notices, and clean git env in auto release

## [0.3.5] - 2026-10-09

- fix: deploys install from a clean checkout of HEAD

## [0.3.4] - 2026-10-09

- feat: phone and browser apply a deployed web app by themselves when idle

## [0.3.3] - 2026-10-09

- feat: the Mac app reloads itself after a deploy once input is idle
- feat: TERMWEAVE_TRUST_LOCAL lets this PC's own direct connections skip the token

## [0.3.2] - 2026-10-09

- feat: live app runs owned releases of this repo and redeploys on every version bump

## [0.3.1] - 2026-10-09

- fix: auto release accepts unchanged values and records every change since the last release
- feat: show which OpenRig seats need a person and why
- fix: public export commits are authored by the GitHub account noreply address
- fix: conventional commit message for public exports

## [0.3.0] - 2026-10-09 (첫 공개 릴리스)

### 2026-10-09

#### Added
- 네이티브 맥 앱 `TermWeave.app`을 추가했습니다. Aside 웹앱 바로가기 대신 WKWebView 창으로 열리고, 로컬 설정 파일의 토큰으로 자동 로그인합니다. 토큰은 앱 파일에 들어가지 않습니다. (`tools/mac-app/`)
- 재부팅 후 에이전트 복원 기능을 추가했습니다. 60초마다 패널별 Claude·Codex 세션 ID를 기록하고, 재부팅 뒤 같은 패널에서 `claude --resume` 또는 `codex resume`을 실행합니다. (`tools/resurrect/`, LaunchAgent `com.voidlight.termweave-resurrect`)
- 실행 중 플러그인을 검사하는 회귀 게이트 `tools/local-fixes/20261009/korean_input_gate.sh`를 추가했습니다. 수정 전 원본에서는 8개 항목이 실패합니다.
- 플러그인을 다시 설치한 뒤 수정 사항을 다시 적용하는 `tools/local-fixes/20261009/apply.sh`와 `plugin-fixes.patch`를 추가했습니다.

#### Changed
- 사이드바 PC 줄의 `+`를 "새 폴더 세션" 만들기로 바꿨습니다. 폴더 선택이 맨 위에 오고, 시작 프로그램의 기본값은 셸입니다.
- 페어링 화면과 알림 아이콘을 TermWeave v2 로고와 이름으로 바꿨습니다. 옛 아이콘 파일도 v2로 교체하고 서비스워커 캐시 이름을 올렸습니다.
- `TermWeave Phone` 앱은 연결에 실패하면 브라우저 대신 TermWeave 앱 창을 엽니다.

#### Fixed
- 네이티브 맥 앱에서 한글이 `ㅎㄱ`처럼 첫 자모만 입력되던 문제를 고쳤습니다. WebKit 한국어 입력기의 교체 입력을 입력창 전후 비교(`imeEdit`)로 처리합니다. 조합 이벤트를 한 번 보면 세션 내내 xterm 경로로 고정되던 동작을 없앴습니다. (PM-20261009-03)
- 한글 바로 뒤의 띄어쓰기가 NBSP(U+00A0)로 셸에 들어가던 문제를 고쳤습니다. WebKit 빠른 타자 시험(키 간격 60·25·12ms, 문장 3개)에서 9/9 문자 단위로 일치합니다. (PM-20261009-04)
- 작은 글자 크기에서 한글 위쪽이 잘리던 문제를 고쳤습니다. 확대된 한글의 글자 크기가 줄 높이를 넘지 않습니다(크기 10: 11px/11px, 크기 13: 15px/15px).

### 2026-10-08

#### Added
- 터미널마다 에이전트 로고를 표시합니다(Claude, Codex, Gemini 등).
- 터미널 "…" 메뉴에 이름 변경과 삭제를 추가했습니다.
- 오픈소스 테마(Catppuccin, Rose Pine 등)와 폰트(D2Coding, JetBrains Mono, Noto Sans KR) 변경 기능을 라이선스와 함께 추가했습니다.
- TermWeave 앱 아이콘과 로고를 적용했습니다. 시안 5개 중 4번(v2)을 선택했습니다.

#### Changed
- 패널 번호를 `%3` 대신 `P3`처럼 전역 번호로 표시합니다.
- 터미널을 지우면 종료 확인 팝업을 띄우고, 확인하면 실제로 종료될 때까지 확인합니다. 왼쪽 사이드바에서도 같습니다.

## 남은 일 (2026-10-09 기준)

- 실제 재부팅 시험으로 에이전트 복원 확인
- P번호로 패널 간 메시지 보내기(현재는 `w1:p1` 형식 주소)
- 전체를 한 번에 "폴더만" 보는 전환
- `herdr-plugin.toml`과 업데이트 안내 문구의 이름·버전 변경
- cmux·herdr 업스트림 자동 반영(개인정보 검사 단계에서 막힘)
- USB 없이 안드로이드 미러링, APK 휴대폰 설치와 LTE 실사용 검증
- Moshi 기능(mosh 방식 연결, 이미지 메모, 음성)
- OpenRig 후속 작업 1건
- 실제 휴대폰에서 모바일 사용성 검증
- 플러그인과 이 저장소의 내용 통합, 그 뒤 GitHub 공개(개인정보 검사와 공개 승인 필요)
