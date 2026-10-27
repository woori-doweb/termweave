# Windows 네이티브 이식 체크포인트 (2026-10-27)

이 문서는 다음 세션이 대화 기록 없이 작업을 이어받기 위한 지침이다. 이 파일과 저장소가 충돌하면 저장소(`git log`, CI, `INSTALL.md`)를 믿는다.

## 1. 현재 상태

| 항목 | 값 |
|---|---|
| 저장소 | `F:/myproject/gjc/teamweave`, 브랜치 `windows-native` |
| origin | `https://github.com/woori-doweb/termweave.git` |
| 원격 `windows-native` | `62b18ff` 이후 이 문서 커밋 |
| 마지막 green CI | run `40463655590`, SHA `62b18ff`. ubuntu-24.04, macos-15, windows-latest 모두 success |
| ultragoal | G001~G005 complete. **G006 active** (`real_machine_pass` false) |
| 계획 정본 | `.gjc/_session-01a16372-c9d9-7570-8438-98981989f916/plans/ralplan/01a16372-c9d9-7570-8438-98981989f916/pending-approval.md` (AC 표 536~560행) |
| 사용자 관점 판정 정본 | `docs/windows-native-usage-acceptance.md`. 기준은 1~8절, 결과는 9절 |

ultragoal 상태는 이전 세션 id 로 접근한다.

```sh
GJC_SESSION_ID=01a16372-c9d9-7570-8438-98981989f916 gjc ultragoal status
```

이 PC 의 실행 환경:

- herdr 0.9.5 설치됨. 경로는 `C:\Users\xarismin\.herdr\packages\standalone\releases\0.9.5-x86_64-pc-windows-msvc\herdr.exe`.
- 헤드리스 서버는 `herdr server` 로 켜 둔 상태다.
- git-bash 에서는 herdr 를 직접 실행하지 못한다. `powershell -NoProfile -ExecutionPolicy Bypass -File $TEMP/g006/h.ps1 <args>` 래퍼를 쓴다.
- TermWeave 설치본은 모두 `--stop` 되어 있다. 소유 프로세스는 0 이다.

## 2. 다음 작업

### 2.1 G006 실기 AC 마무리

실기 AC 는 AC-I1, I3, I5, B1~B5, U1, U2 다.

**통과한 AC (agent 판정)**

- AC-I1, AC-I5, AC-B1, AC-B2, AC-B3, AC-B4, AC-U1.
- 판정 run 은 `g006-off-1`, `g006-on-1` 이다.
- 증거는 `evidence/windows-native/<run>/` 에 있다(gitignore).

**남은 AC (사용자 입력 대기)**

| AC | 필요한 것 | 절차 |
|---|---|---|
| AC-B5 | 사용자가 Needs-you 표시를 육안 확인 | 1. 새 run 을 init/설치/pane 한다. 2. `pane report-agent --state blocked` 로 대상 패널을 blocked 로 둔다. 3. 사용자가 확인하면 `edge-before` → `edge-after --by user --verdict AC-B5=pass` 순으로 기록한다. `g006-on-1` 은 이미 중지했고 `edge-after` 는 한 번만 쓸 수 있으므로 새 run 을 쓴다 |
| AC-U2 | 정본 한글 9문장 파일 | 1. 사용자에게서 받는다(UTF-8, BOM 없음, LF, 정확히 9줄). 2. `ime-before --run R --sentences FILE --sha256 HEX --source TEXT --ime TEXT` 를 기록한다. 3. 사용자가 MS 한글 IME 로 입력한다. 4. `ime-after` 를 기록한다 |
| AC-I3 | 깨끗한 계정에서 `--yes` 한 번으로 설치 | 이 계정에서는 불가하므로 `verdict` 로 not-run 과 사유를 기록한다 |

- AC-U2 가 실패하면 원인을 AC-U3 로 분류한다.
- 3G-C 는 원인이 server stall/clear 일 때만 시작한다.

**도구 규칙** (`scripts/windows-native-acceptance.ts`)

- run 마다 새 `--dir` 을 쓴다.
- 증거 파일은 한 번만 쓴다. 실패한 AC 는 덮어쓸 수 없다.
- 끝은 다음 순서로 마무리한다.
  1. `stop-before`
  2. `exec … install.ps1 --stop --dir …`
  3. `stop-after`
  4. `pane-close`
  5. `finish`. CI SHA 가 설치본 `source_sha` 와 같아야 한다.

### 2.2 사용자 관점 판정에서 남은 것

이 항목들은 `docs/windows-native-usage-acceptance.md` 9.5 에 기록돼 있다.

**고칠 수 있는 제품 문구 결함 (아직 손대지 않음)**

1. `install.ps1` 안내는 "about a minute" 지만 실측은 215~471 s 다.
2. 준비 실패 안내가 `install.ps1 --check` 에 `--dir` 을 빠뜨린다.
3. 안드로이드 설정 패널이 Windows 에서도 "서버가 실행되는 맥" 이라고 안내한다.

**TermWeave 밖이거나 설계 한계 (기록만 함)**

- Ctrl+C 로 실행 중인 프로세스를 중단할 수 없다. herdr 측 결함이며, herdr CLI `send-keys ctrl+c` 로도 재현된다.
- mirror 에 휠 스크롤백이 없다.
- 헤드리스 120x40 고정이라 분할할 때마다 폭이 반으로 준다.
- herdr 유휴 CPU 가 약 4.6 % 다.

## 3. 완료된 것

### G005: 계획 5B·5C (커밋 `47619df..46ec51c`)

**5B CI**

- `.github/workflows/termweave-ci.yml`: 단일 `verify` job.
- 3-OS 매트릭스, fail-fast false.
- Bun 1.4.2 고정.
- 아티팩트는 `if: always()` 로 올린다.

**5B 가드**

- `scripts/check-windows-invariants.mjs`: TS AST 와 PS parser 로 가드 5개를 검사한다.

**5C: Windows unit 실패 99건 → 0건**

제품 수정:

- `server/windows-process-info.ts`: ntdll in-process 프로세스 식별. CIM 경로는 제거했고 폴백은 없다.
- `server/private-file.ts`: 비밀 파일에 owner-only DACL 을 건다.
- `scripts/owned-install.ts`: owned root DACL 을 `SetNamedSecurityInfoW` 로 통째 설정한다.
- `scripts/release/activate.ts`: `replaceFile`. win32 에서 FileRenameInfoEx POSIX_SEMANTICS 로 교체한다.
- `scripts/lifecycle-path.ts`: ENOTDIR 를 부재로 판정한다.

### 사용자 관점 판정 (커밋 `d86e468..62b18ff`)

**판정 결과**

- 통과: C1~C5, P1~P8, F1~F3, F6, F8~F17.
- 실패: F4 Ctrl+C, F5 스크롤, F7.
- 미판정: F18. 사용자가 수행해야 한다.

**판정 중 고친 결함**

| 커밋 | 수정 |
|---|---|
| `07ba3ce` | win32 에서 단독 Esc 를 herdr `send_keys esc` 로 보낸다(`server/mirror-input.ts` `mirrorKeys`). herdr 0.9.5 가 send_text 의 단독 ESC 를 버리기 때문이다 |
| `07ba3ce` | win32 에서는 tmux 런타임을 쓰지 않는다(`server/tmux/runtime.ts`). PATH 의 psmux `tmux.exe` 로 400 이 나던 문제다 |
| `76dfc1a` | 툴팁이 `shortcutHint()` 로 플랫폼별 키와 사용자 바인딩을 표시한다 |
| `3da4150` | git 을 많이 쓰는 테스트 2개에 30 s 예산을 줬다. assertion 은 바꾸지 않았다 |
| `62b18ff` | pane-mesh ownership 동시 첫 시작의 sentinel 교체를 `replaceFile` 로 바꿨다. Windows rename EPERM 경합 때문이다. 수정 전 16/160 → 수정 후 0/320. 회귀 테스트는 10개 동시 시작이며 확률적 검출이다(구 코드에서 7/11 실패) |

## 4. 지켜야 할 규칙

**git**

- 허용: 로컬 커밋, `windows-native` 를 origin 에 push.
- 금지: main push, upstream push, PR 생성.
- 금지: 무단 stash, reset, force push. 자기 변경의 비교에도 stash 를 쓰지 않는다. 임시 사본으로 바꿔 비교한 뒤 복원한다.
- push 는 gh 자격 증명으로 한다. GCM 토큰에는 `workflow` scope 가 없다.

```sh
git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push origin windows-native
```

**범위**

- 비목표(f-nongoals-v5 1~9)를 지킨다.
  - ConPTY 직접 소유, 네이티브 창, imeDiff, 플러그인 경로, mirror 렌더 개선은 하지 않는다.
  - 3G-C 는 조건부다. 조건 없이 시작하지 않는다.

**테스트 분류**

- 분류는 세 가지다: (a) 제품 수정, (b) 테스트 수정, (c) POSIX 전용.
- (c) 만 단일 테스트 `skipIf(win32)` 를 쓸 수 있다. 사유 주석이 필요하고, 목록은 `INSTALL.md` 에 둔다.
- 파일/폴더 단위 skip 은 금지다.
- assertion 약화는 금지다.
- retry 는 금지다.

**보안·세션**

- `.gjc/` 는 서브에이전트가 건드리지 않는다.
- 토큰, SID, 기기 식별자를 출력하지 않는다.
- Bun 장시간 세션은 mimalloc segfault 로 죽은 적이 있다. 긴 세션을 이어가지 말고, 새 세션에서 이 파일을 읽고 이어간다.

**사용자 관점 측정 주의**

- Playwright `connectOverCDP` 는 focus emulation 을 켠다. 그래서 창을 최소화해도 `visibilityState` 가 바뀌지 않는다.
- 가시성(P5)은 raw CDP 로 잰다. 스크립트는 `evidence/usage-harness/p5-raw.ts` 다.
- CDP Edge 는 별도 프로필(`$TEMP/uat/edge-profile`)과 `--remote-debugging-port=9333` 으로 띄운다.
- 하네스는 `evidence/usage-harness/run.ts` 다. gitignore 대상이다.

## 5. 검증 명령

```sh
bun scripts/verify-isolated.ts type build unit render source-style   # 로컬 Windows: 7/7 PASS, unit 1549/38/0
bun scripts/check-windows-invariants.mjs                             # 5/5 guards
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows-install.test.ps1   # 14 passed
gh run list -R woori-doweb/termweave --branch windows-native
```

CI 가 실패하면:

1. `gh run download <id> -R woori-doweb/termweave` 를 실행한다.
2. 받은 `termweave-ci-<os>/ci/counts.json` 과 `p3/<run>/unit.txt` 를 본다.

알려진 flaky 테스트:

- macOS `server/collector.test.ts:213`: `tick(20)` 타이밍에 의존한다. `--failed` 로 재실행해 확인했다.

## 6. 알려진 한계

- Windows pane-mesh task 소유권은 구현되지 않았다. CLI 는 `native_server_identity_unavailable` 로 fail closed 한다.
- pane-directory 의 herdr 세대 live 확인(lsof/ps)은 Windows 에 없다. fail closed 한다.
- 5cMesh 상태 디렉터리와 handle 파일은 프로필 상속 ACL 에 의존한다. 비밀은 아니다.
- 사용자 관점 한계는 2.2 절에 있다: Ctrl+C, 스크롤백, 분할 폭, herdr 유휴 CPU.
