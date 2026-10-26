# Windows 네이티브 이식 체크포인트 (2026-10-26)

다음 세션이 대화 기록 없이 이어받기 위한 작업 지침이다. 이 파일과 저장소가 충돌하면 저장소(`git log`, CI, `INSTALL.md`)를 믿는다.

## 1. 현재 상태

| 항목 | 값 |
|---|---|
| 저장소 | `F:/myproject/gjc/teamweave`, 브랜치 `windows-native` |
| origin | `https://github.com/woori-doweb/termweave.git` |
| 원격 `windows-native` | `46ec51c` (G005 완료 시점) |
| 마지막 green CI | run `40005071507`, SHA `46ec51c`, ubuntu-24.04 / macos-15 / windows-latest 전부 success |
| ultragoal | G001~G005 complete, **G006 active** (nudge 0/10) |
| 계획 정본 | `.gjc/_session-01a16372-c9d9-7570-8438-98981989f916/plans/ralplan/01a16372-c9d9-7570-8438-98981989f916/pending-approval.md` |

ultragoal 상태는 이전 세션 id 로 접근한다.

```sh
GJC_SESSION_ID=01a16372-c9d9-7570-8438-98981989f916 gjc ultragoal status
```

## 2. 다음 작업: G006 Windows 실기 검증

목표: 계획의 실기/E2E 절. AC-I3, AC-I5, AC-B1~B5, AC-U1, AC-U2.

1. 새 `--dir` 에 설치하고 `source_sha` 가 후보 HEAD 와 같은지 확인한다.
2. herdr 꺼짐: readiness 실패 안내, bridge-only liveness, `install.ps1 --stop` 후 프로세스 N→0.
3. herdr 켜짐: Edge 앱 창(`msedge --app=http://127.0.0.1:7317`)에서 workspace/pane 표시, split, 입력 왕복, 에이전트 아이콘.
4. 한글 9문장: 사용자가 MS 한글 IME 로 입력하고 에이전트가 `pane.read` 로 글자 단위 비교한다.
5. Needs-you 표시는 사용자가 육안 확인한다.
6. M10 증거는 `scripts/windows-native-acceptance.ts` 로 `evidence/windows-native/<run-id>/` 에 남긴다. `--self-test` 는 실기 증거가 아니다.

### 사용자 입력 대기 (에이전트 단독 진행 불가)

| 항목 | 상태 |
|---|---|
| herdr 설치·실행 | 이 PC 에 없음(`install.ps1 --check` exit 2). `--yes` 는 공식 설치기를 실행하므로 사용자 승인 필요 |
| 한글 9문장 원문 | 공개 ref 어디에도 없음(워크트리, 전 커밋, upstream `209c913`/v0.3.27). CHANGELOG 는 비공개 메모 PM-20261009-04 만 인용. 사용자에게 UTF-8 파일로 요청 |
| IME 입력·Needs-you 확인 | 사용자 실기 작업 |

## 3. 완료된 것 (G005 = 계획 5B·5C, 커밋 `47619df..46ec51c`)

- 5B CI: `.github/workflows/termweave-ci.yml` 단일 `verify` job, 3-OS 매트릭스, fail-fast false, Bun 1.4.2 고정, 아티팩트 `if: always()`.
- 5B 가드: `scripts/check-windows-invariants.mjs` (TS AST + PS parser) 5개 가드, 의도적 위반 24건 각각 고유 메시지로 실패.
- 5C: Windows unit 실패 99건 분류 후 0건. 제품 수정:
  - `server/windows-process-info.ts`: ntdll in-process 프로세스 식별(NtOpenProcess/NtQueryInformationProcess). CIM 경로 제거, 폴백 없음. denied/error 는 gone/match 로 취급하지 않는다. lock/inspect 의 기본 identity.
  - `server/private-file.ts`: 비밀 파일(voice/devices/vapid/push-subscriptions) owner-only 보호 DACL, CREATE_NEW, 읽어 검증, fail closed.
  - `scripts/owned-install.ts`: owned root DACL 을 `SetNamedSecurityInfoW` 로 통째 설정. 검증은 별도(`icacls /save` + `isOwnedRootDacl`, SDDL 별칭은 `scripts/windows-sid.ts` 로 정규화, mandatory-label SACL 허용).
  - `scripts/release/activate.ts`: win32 FileRenameInfoEx POSIX_SEMANTICS 교체.
  - pane-directory / pane-mesh / terminal-mesh / pane-context 의 네이티브 절대 경로.
  - `scripts/lifecycle-path.ts`: POSIX ENOTDIR 를 부재로 판정.
- `scripts/windows-plugin.test.ts` 폐기(`47619df` 에 섞여 들어감, rebase 하지 않음).

## 4. 지켜야 할 규칙

- 허용: 로컬 커밋, `windows-native` 의 origin push. 금지: main push, upstream push, PR 생성, 무단 stash/reset/force push.
- push 는 gh 자격 증명으로 한다(GCM 토큰에 `workflow` scope 없음):
  `git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push origin windows-native`
- 비목표(f-nongoals-v5 1~9) 유지: ConPTY 직접 소유, 네이티브 창, imeDiff, 플러그인 경로, mirror 렌더 개선 없음. 3G-C 는 조건부로 시작하지 않는다.
- 테스트 분류: (a) 제품 수정 (b) 테스트 수정 (c) POSIX 전용. (c) 만 단일 테스트 `skipIf(win32)` + 사유 주석 + 대체 커버리지, 목록은 `INSTALL.md` "Windows test coverage and POSIX-only skips". 파일/폴더 skip, assertion 약화, retry 금지. POSIX 동작은 바이트 동일.
- `.gjc/` 는 서브에이전트가 건드리지 않는다. 토큰·SID·기기 식별자 출력 금지.
- Bun 1.4.0 장시간 세션은 mimalloc segfault 로 죽은 적이 있다. 긴 세션 대신 새 세션에서 이 파일로 이어간다.

## 5. 검증 명령

```sh
bun scripts/verify-isolated.ts type build unit render source-style   # 로컬 Windows: 7/7 PASS, unit 1544/38/0
bun scripts/check-windows-invariants.mjs                             # 5/5 guards
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows-install.test.ps1   # 14 passed
gh run list -R woori-doweb/termweave --branch windows-native
```

CI 실패 시 `gh run download <id> -R woori-doweb/termweave` 로 `termweave-ci-<os>/ci/` 아티팩트(counts.json, windows-install.test.txt)를 본다. windows-latest runner 는 관리자 권한 `runneradmin`(RID 500) 이고 느리다.

## 6. 알려진 한계 (G005 범위 밖, 후속 설계)

- Windows pane-mesh task 소유권 미구현: CLI 는 `native_server_identity_unavailable` 로 fail closed.
- pane-directory 의 herdr 세대 live 확인(lsof/ps)은 Windows 에 없다: fail closed.
- 5cMesh 상태 디렉터리·handle 파일은 프로필 상속 ACL 에 의존한다(비밀 아님).
