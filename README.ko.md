# coagent

[English](./README.md) · [한국어](./README.ko.md)

Claude Code 에이전트와 사람이 함께 쓰는 멀티 참가자 채팅 허브.

채팅방을 하나 띄우고, 동시에 다루는 프로젝트마다 Claude Code 에이전트를 한 명씩 붙이세요.
한 터미널에서 그들을 조율할 수 있습니다. 각 에이전트는 자기 작업 디렉토리에서
Claude Code 의 모든 도구(Read, Grep, Bash, Edit 등)를 그대로 씁니다.
`@이름` 멘션으로 누구한테 말할지 정하고, 절대경로로 파일을 공유하고, 슬래시 커맨드로 세션을 제어합니다.

## 설치

```bash
npm i -g @vincentjang/coagent
```

`coagent` 명령이 글로벌로 설치됩니다. Node 20 이상 필요.

## 빠른 시작

```bash
# 1) 허브 시작
coagent hub

# 2) 다른 터미널에서 프로젝트마다 에이전트 붙이기
coagent agent backend ~/Dev/api-server
coagent agent frontend ~/Dev/web-app

# 3) 사람으로 접속
coagent human vincent
```

휴먼 TUI 안에서:

```
@backend 인증 미들웨어 좀 보여줘
@frontend /home/vincent/Dev/web-app/src/api/client.ts 보고
  방금 backend가 말한 거랑 일치하는지 확인해줘
@all 각자 알아낸 거 요약해줘
```

## 명령어

```
coagent hub [--host <addr>]
coagent agent <name> [path] [--model <id>] [--resume]
coagent human <name>
coagent update                          # 자가 업데이트 (npm 최신 버전 재설치)
coagent --version
```

`--resume` 을 주면 그 디렉토리의 과거 Claude Code 세션 목록 (`~/.claude/projects/`)
이 picker 로 떠서, fresh 대신 기존 대화를 이어받을 수 있습니다.

`--model <id>` 로 에이전트가 사용할 Claude 모델을 고정할 수 있습니다
(예: `claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-7`).
환경변수 `AGENT_MODEL=<id>` 로도 가능 — 둘 다 주면 플래그가 우선합니다.
둘 다 없으면 SDK 기본값을 씁니다. 런타임에 휴먼 TUI 에서
`/model <agent> <id>` 로도 바꿀 수 있고, 다음 턴부터 적용됩니다.

에이전트의 `path` 는 상대경로(현재 셸 cwd 기준) 또는 절대경로 둘 다 가능. 기본값은 현재 디렉토리.

### 네트워크 & 안전

기본적으로 hub 는 `127.0.0.1` 에만 바인드 — 같은 머신에서만 붙을 수 있습니다.
LAN 에 노출하려면 `--host 0.0.0.0` (또는 `HUB_HOST=0.0.0.0`) 을 명시적으로 줘야 합니다.
허브에는 인증이 없으므로, 포트에 닿을 수 있는 누구든 채팅방에 들어올 수 있다는 점을 유의하세요.

에이전트의 `HUB_URL` 이 로컬 주소가 아니면 자동으로 `acceptEdits` 모드로 시작합니다
(Bash/네트워크 도구는 승인을 요구). 디폴트인 `bypassPermissions` 로 다시 올리려면
신뢰할 수 있는 사람이 `/mode <agent> auto` 로 직접 지정.

슬래시 커맨드 (control op) 는 사람만 보낼 수 있습니다 — 에이전트가 다른 에이전트를
`/kill` 하거나 `/mode` 를 바꿀 수 없습니다.

### 슬래시 커맨드 (휴먼 TUI 안에서)

`<agent>` 자리에 `all` (또는 `@all`)을 넣으면 방에 있는 모든 에이전트에게
같은 명령이 fan-out 됩니다. 각 에이전트가 자기 ack 을 따로 보내므로,
명령당 에이전트 수만큼 응답 라인이 뜹니다.

- `/clear <agent|all>` — 에이전트의 Claude 세션과 컨텍스트 초기화 (진행 중인 턴은 abort)
- `/compact <agent|all>` — 세션을 요약·압축해서 컨텍스트 여유 확보
- `/status <agent|all>` — 세션 ID, 권한 모드, 현재 task, 큐, 턴 수, 비용
- `/usage <agent|all>` — 누적 토큰 사용량과 비용 (모델별 분리)
- `/mode <agent|all> <plan|accept|auto|default>` — 권한 모드 변경
- `/model <agent|all> [<id>|default]` — 에이전트 모델 조회/변경 (다음 턴부터 적용)
- `/pause <agent|all>` / `/resume <agent|all>` — 큐 처리 일시 중지 / 재개 (진행 중인 턴은 그대로 마침)
- `/kill <agent|all>` — 에이전트 프로세스 종료 (진행 중인 턴은 abort)
- `/quit` — 채팅방 나가기

### 멘션

- `@alice` — 특정 참가자에게 말하기
- `@all` — 모두에게 한 번에 알리기
- 입력창에 `@` 를 치면 참가자 + 현재 디렉토리 파일이 같이 뜨는 자동완성 팝업이 나옵니다. Tab 또는 Enter 로 선택.

### 파일 참조

메시지에 그냥 경로를 적으면 됩니다. 상대/절대경로 모두 OK. 자동완성 받고 싶으면 앞에 `@` 를 붙이세요.
TUI가 전송 직전에 상대경로를 절대경로로 변환해서 모든 에이전트가 같은 파일을 읽도록 보장합니다.

```
@alice @./src/auth.ts 검토하고 /home/vincent/notes.md 와 비교해줘
```

### 줄바꿈

입력창에서 줄바꿈은 다음 중 하나:

- `Shift+Enter` — kitty keyboard protocol 지원 터미널 (iTerm2, WezTerm, kitty, Alacritty, Ghostty 등)에서 동작
- `Alt+Enter` (macOS는 `Option+Enter`) — kitty 미지원 터미널에서도 동작
- `Ctrl+J` — 어떤 터미널에서든 동작

`Enter` 만 누르면 메시지 전송.

## 상태 저장

coagent 는 디스크에 아무것도 저장하지 않습니다. 에이전트와 hub 는 순수 프로세스 —
띄우고, 쓰고, 죽이면 끝. Claude 세션은 에이전트 띄울 때마다 새로 만들어집니다.
재시작해도 컨텍스트를 유지하고 싶으면 에이전트를 죽이지 말고 계속 두세요.

에이전트가 살아있는 동안 "오늘 우리 뭐 했지?" 같은 게 궁금하면 그 에이전트한테
직접 물어보세요. 각자 자기 쓰레드를 기억하고 있습니다.

허브가 잠깐 끊기면 (재시작, 네트워크 흔들림 등) 에이전트와 휴먼은 백오프로
자동 재연결하면서 기존 Claude 세션을 그대로 이어갑니다. 이름 충돌이나 잘못된
핸드셰이크 같은 fatal 거절은 재연결하지 않고 종료합니다.

## 환경변수

- `HUB_URL=ws://host:port` — 허브 주소 (기본 `ws://localhost:8787`)
- `HUB_HOST=addr` — 허브 바인드 주소 (`--host` 가 우선)
- `PORT=8787` — 허브 listen 포트
- `AGENT_MODEL=<id>` — 에이전트 기본 모델 (`--model` 플래그가 우선)

## 자동 업데이트 알림

새 버전이 나오면 다음 실행 시 박스 알림이 뜹니다:

```
╭──────────────────────────────────────────────────╮
│  Update available 0.1.10 → 0.1.11                │
│  Run coagent update to install.                  │
╰──────────────────────────────────────────────────╯
```

`coagent update` 한 번이면 끝.

## Claude Code 와의 관계

각 에이전트는 작업 디렉토리에 묶인 `claude-agent-sdk` 인스턴스 하나일 뿐입니다.
채팅 허브는 자그마한 WebSocket 라우터고요. 멘션은 "누가 다음 턴을 가져갈지" 신호 — 멘션된 에이전트만 실제로 메시지를 처리합니다.

채팅 인프라 자체는 JavaScript/Node 로 짜여있지만, **에이전트들이 작업하는 프로젝트는 어떤 언어든 상관없습니다**.
Python, Go, Rust, Terraform 등 Claude Code 가 읽고 편집할 수 있는 모든 것.

```bash
coagent agent backend ~/Dev/django-app          # Python
coagent agent service ~/Dev/go-service          # Go
coagent agent infra ~/Dev/terraform-prod        # Terraform
```

## 라이선스

MIT
