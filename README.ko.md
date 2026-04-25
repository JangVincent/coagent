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
coagent hub
coagent agent <name> [path] [--new]
coagent human <name>
coagent update                          # 자가 업데이트 (npm 최신 버전 재설치)
coagent --version
```

에이전트의 `path` 는 상대경로(현재 셸 cwd 기준) 또는 절대경로 둘 다 가능. 기본값은 현재 디렉토리.

### 슬래시 커맨드 (휴먼 TUI 안에서)

- `/clear <agent>` — 에이전트의 Claude 세션과 컨텍스트 초기화
- `/compact <agent>` — 세션을 요약·압축해서 컨텍스트 여유 확보
- `/status <agent>` — 세션 ID, 권한 모드, 큐, 턴 수, 비용
- `/usage <agent>` — 누적 토큰 사용량과 비용 (모델별 분리)
- `/mode <agent> <plan|accept|auto|default>` — 권한 모드 변경
- `/pause <agent>` / `/resume <agent>` — 메시지 처리 일시 중지 / 재개
- `/kill <agent>` — 에이전트 프로세스 종료
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

## 데이터 저장 위치

채팅 자체는 디스크에 남기지 않습니다 — hub 는 매번 빈 상태로 시작.
각 에이전트의 Claude 세션 ID 만 파일로 저장돼서 프로세스를 재시작해도
에이전트 본인의 컨텍스트는 유지됩니다.

```
~/.data/coagent/
  sessions/
    <name>_<cwdhash>.json     # (에이전트, cwd) 별 Claude 세션 ID
```

다른 위치 쓰고 싶으면: `DATA_DIR=/some/path coagent ...`

"오늘 우리 뭐 했지?" 같은 게 궁금하면 에이전트한테 직접 물어보세요. 각 에이전트가
자기 쓰레드를 다 기억하고 있습니다 (Claude 세션). hub 자체는 단순 라우터입니다.

## 환경변수

- `HUB_URL=ws://host:port` — 허브 주소 (기본 `ws://localhost:8787`)
- `PORT=8787` — 허브 listen 포트
- `DATA_DIR=~/.data/coagent` — 데이터 디렉토리

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
