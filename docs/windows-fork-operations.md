# 포크 운영 지침: VoidLight00 업데이트 확인, Windows 버전 이관, 설치본 갱신과 점검

- type: 운영 지침(정본)
- purpose: 이 포크(`woori-doweb/termweave`)에서 원본 업데이트를 확인하고, Windows 버전으로 이관하고, 로컬 설치본을 갱신·점검하는 순서를 하나로 고정한다
- scope: 포크 `main`, `.github/workflows/voidlight-upstream-check.yml`, `install.ps1`, 실행 중인 설치본(`%LOCALAPPDATA%\termweave-owned`)
- summary: 원본은 확인만 하고 이관은 포크에서 PR로 한다. 설치본은 멈춤 → 백업 → 새 설치 → 점검 순서로 갱신한다. 화면 이상은 앱보다 클라이언트 브라우저를 먼저 의심한다
- 근거: 2026-11-06 세션 (Windows 버전 `054d7d6` → v0.3.32 이관 `625f31d`, 확인 워크플로 `65cf7c9`)

## 1. 저장소 역할

| 저장소 | 역할 |
|---|---|
| `woori-doweb/termweave` (origin) | 제품 정본. Windows 네이티브 기능은 이 포크에서 만들었다. `main`이 Windows 버전이다 |
| `VoidLight00/termweave` (upstream) | 업데이트를 받아 오는 출처. 확인만 하고, 이 저장소에 PR로 이관하지 않는다 |

- 로컬 원격: `origin`=포크, `upstream`=`https://github.com/VoidLight00/termweave.git`.
- 원본에 열려 있는 Windows PR(#2)은 이관 경로가 아니다. 포크 `main`이 기준이다.
- 원본 이름이 남은 곳(`package.json` 저장소 URL, `AGENTS.md` clone 주소, 설정 화면 링크, `CITATION.cff`, `CODEOWNERS`, 보안 신고 링크, herdr 플러그인 id `VoidLight00.termweave`)은 결정 전까지 바꾸지 않는다. 플러그인 id를 바꾸면 기존 설치의 설정 폴더 위치가 달라진다.

## 2. 원본 업데이트 확인

- 워크플로 `VoidLight00 upstream check`(`.github/workflows/voidlight-upstream-check.yml`)가 매일 00:23 UTC(09:23 KST)와 수동 실행 때 원본 `main`을 가져와 포크 `main`과 비교한다.
- 포크 `main`이 원본을 이미 포함하면 요약에 `main already contains VoidLight00 <sha>`를 남긴다.
- 포함하지 않으면 `VoidLight00 update pending` 경고를 띄우고, 요약에 남은 커밋 목록과 병합 충돌 파일 목록을 남긴다.
- 포크는 Issues가 꺼져 있어 알림은 실행 결과의 경고로만 남는다.
- 상속된 `Observe upstream candidates`(`upstream-watch.yml`)는 원본 자체의 상위 프로젝트(herdr-web-ui, herdr, cmux)를 감시한다. 포크에는 `upstream-watch-state` 브랜치가 없어 HTTP 404로 실패하므로 Actions API로 비활성화했다. 원본 병합 때 충돌하지 않도록 파일은 그대로 둔다.

로컬에서 확인하는 방법:

```sh
git fetch origin && git fetch upstream
git rev-list --left-right --count origin/main...upstream/main   # 오른쪽 수 = 아직 이관하지 않은 원본 커밋
git merge-tree --write-tree --name-only origin/main upstream/main # 종료 코드 1이면 충돌 파일이 출력된다
```

## 3. Windows 버전으로 이관하기 (포크에서)

1. 작업 트리를 깨끗하게 하고 `git switch -c sync/upstream-<버전> origin/main`으로 이관 브랜치를 만든다.
2. `git merge --no-ff --no-commit upstream/main`을 실행한다. 원본 이력이 남도록 rebase나 squash를 쓰지 않는다.
3. 충돌은 다음 원칙으로 푼다.
   - 경로 허용 목록 같은 합집합 성격의 코드는 양쪽을 모두 살린다. 예: `server/machine-api.ts`의 `MACHINE_PROXY_PATH`에서 포크의 `worktree/*`와 원본의 `workspace/directory/create`를 함께 둔다. 같은 원칙을 테스트(`server/machines.test.ts`)에도 적용한다.
   - 원본 쪽 테스트 파일을 받고 Windows 보호 조건을 다시 붙인다. 예: `scripts/pane-mesh-roster.test.ts`는 `--theirs`로 받은 뒤 다음을 다시 붙인다.
     - `posixHost` 상수
     - `beforeAll`의 Windows 조기 반환. Windows에는 python3가 없을 수 있다.
     - 새 테스트를 포함한 모든 테스트의 `it.skipIf(!posixHost)`
     - `describe.skipIf(!posixHost || !jq)`
   - 원본 새 기능에 Windows 경로·이름 처리가 있는지 확인한다. 예: v0.3.32의 `createProjectDirectory`는 예약어와 금지 문자를 이미 거부한다.
4. 로컬 검증:

   ```sh
   bun install --frozen-lockfile
   bun scripts/verify-isolated.ts type build unit source-style
   ```

   - 증거는 `evidence/p3/<run>/result.json`에 남는다.
   - 심볼릭 링크 권한이 없는 PC에서는 unit 중 약 18건이 `EPERM: operation not permitted, symlink`로 실패한다. 이 PC의 환경 제약이다. 실패 목록이 모두 symlink EPERM인지 확인하고, 최종 판정은 GitHub Windows CI로 한다.
5. 커밋한 뒤 브랜치를 push하고 포크 `main`으로 PR을 연다.
   - CI(`TermWeave isolated verification`)는 `pull_request`와 `main`·`windows-native` push에서만 돈다. 브랜치 push만으로는 돌지 않는다.
   - PR 제목은 semantic 규칙(`feat`/`fix`/`chore`/`docs`/`ci` 등)을 따른다. `merge(...)`는 `PR triage`의 title 검사에서 실패한다.
6. 검사(Windows·macOS·Ubuntu verify, CodeQL, PR triage)가 모두 성공하면 merge 커밋 방식으로 병합한다.
7. 병합 직후 `main` push 실행이 `cancelled`로 끝날 수 있다. 이때는 그 실행을 다시 돌려(`POST /actions/runs/<id>/rerun`) 성공을 확인한다.

## 4. 실행 중인 설치본 갱신

`install.ps1`은 설치 폴더가 이미 있으면 다시 쓴다(`already installed ... (reused)`). 새 커밋으로 올리려면 폴더를 새로 만들어야 한다. 서비스가 멈추므로 사용자 승인 후에 진행한다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 --stop
Rename-Item "$env:LOCALAPPDATA\termweave-owned" "termweave-owned.bak_<YYYYMMDD_HHMMSS>"   # 되돌리기용 백업
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1                             # 깨끗한 clone의 HEAD를 설치하고 시작
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 --check                     # exit 0
```

- 설치 원본은 깨끗한 clone이어야 한다. 커밋하지 않은 변경이 있으면 설치가 실패한다.
- 사용자 상태(기기, 알림, 색상, 패널 번호 등)는 `~\.config\termweave`(또는 `HERDR_WEB_STATE_DIR`)에 있어 설치 폴더 교체와 무관하다.
- herdr 세션과 패널은 herdr가 유지하므로 서버를 재시작해도 끊기지 않는다.
- 설치본이 어느 커밋인지는 `.termweave-owned.json`의 `source_sha`로 확인한다.
- 멈출 때는 `install.ps1 --stop`만 쓴다. `lifecycle.json`의 `stop_token`은 출력하거나 기록하지 않는다.
- 백업 폴더는 점검이 끝난 뒤 사용자 확인을 받고 지운다.

## 5. 기본 운영 점검

| 점검 | 기대 결과 |
|---|---|
| `install.ps1 --check` | exit 0, 우리가 띄운 서버가 7317에서 실행 중, health 응답 |
| `source_sha` | 이관한 포크 `main` 커밋과 같음 |
| `GET /api/health` | `ok:true`, herdr 버전과 protocol 표시 |
| `GET /api/session` | 기존 워크스페이스와 패널이 그대로 있음 |
| `server.log` | error·exception·fail 0건 |

동작 점검은 테스트 전용 자원만 쓴다. 사용자 패널에는 입력하지 않는다. POST 요청에는 `origin: http://127.0.0.1:7317`을 붙인다.

1. `%TEMP%`에 임시 상위 폴더를 만든다.
2. `POST /api/workspace/directory/create`로 다음을 확인한다.
   - 정상 이름: 200과 `path`
   - 같은 이름 다시: `folder_exists`
   - `con`, `a:b`: `invalid_folder_name`
3. `POST /api/workspace/create {cwd, label}`로 테스트 워크스페이스를 연다.
4. `POST /api/pane/input`와 `POST /api/pane/keys ["enter"]`로 명령을 보내고, `GET /api/pane/read?pane_id=...&lines=15`로 출력을 확인한다.
5. `POST /api/workspace/close`로 닫고 임시 폴더를 지운 뒤, 워크스페이스 목록이 원래대로인지 확인한다.
6. 화면은 헤드리스 브라우저로 버전 표시, 연결 상태, `.xterm` 존재, `scrollWidth == innerWidth`를 확인한다. 새 기능의 대화상자를 열었다 닫아 본다.

## 6. 화면 이상 진단

- 터미널 크기는 모든 클라이언트가 공유하고, 마지막으로 크기를 바꾼 클라이언트가 이긴다. 헤드리스 브라우저나 두 번째 창을 붙이면 사용자 터미널 크기가 바뀐다.
  - 점검용 탭은 사용자 창과 비슷한 뷰포트로 열고, 끝나면 바로 닫는다.
  - 사용자에게는 클라이언트를 하나만 쓰도록 안내한다.
- TUI 화면이 터미널 폭보다 좁거나 넓으면 먼저 프로그램이 이미 끝났는지 확인한다. 끝난 프로그램의 마지막 화면은 당시 폭으로 남아 있다.
- 페이지 전체(헤더 오른쪽 아이콘, 사이드바 하단)가 창 밖으로 잘리면 앱 레이아웃보다 클라이언트를 의심한다.
  - 같은 폭의 헤드리스 Chromium에서 넘침이 없으면 앱 문제가 아니다.
  - 확인된 사례: Aside 브라우저가 페이지를 약 5% 크게 그려 오른쪽·아래가 잘렸다.
  - 대응: 클라이언트 확대 배율을 100%로 되돌리거나(Ctrl+0), `msedge --app=http://127.0.0.1:7317`로 연다.
- 사용자 창 캡처는 Win32 `PrintWindow`로 대상 창 핸들만 찍는다. 가려져 있어도 찍힌다.
  - 창 찾기는 제목(`TermWeave - `)으로 한다. 프로세스의 `MainWindowHandle`은 브라우저 창이 바뀌면 다른 창을 가리킬 수 있다.
  - 창 크기 변경(`MoveWindow`)으로 진단하지 않는다.

## 7. 도구 사용 주의

- `gh` 인증이 만료됐을 때 `git push`는 Git Credential Manager로 동작한다.
  - API 쓰기(PR 생성·병합, 워크플로 비활성화·실행)는 `git credential fill`로 얻은 토큰을 셸 변수로만 쓴다. 토큰을 출력하거나 기록하지 않는다.
- 인증 없는 GitHub API는 시간당 60회 제한이 있다. CI 상태를 반복해서 조회할 때는 인증 헤더를 붙인다.
- bash에서 `powershell -Command "..."`로 넘기면 `$` 변수가 bash에서 먼저 풀린다. PowerShell 코드는 임시 `.ps1` 파일로 실행하고 끝나면 지운다.
- bash에서 PowerShell 인자로 경로를 넘길 때는 `/` 구분자를 쓴다. `\`는 사라진다.
- 임시 파일은 저장소 밖에 만들고 작업이 끝나면 지운다.
