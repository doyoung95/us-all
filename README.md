> [!NOTE]
> 구현 코드와 설계 결정은 직접 작성했고, 이 문서와 일부 테스트 코드는
> 구현 의도를 Claude Code 에 설명한 뒤 정리·보완했습니다.

## 실행 방법

### 요구 환경

- **Node.js 20.19 이상** (20 / 22 / 24 LTS 계열)
- npm

의존성 중 `@nestjs/schedule` 이 `>=20.19.0`, `vitest` 가 `^20 || ^22 || >=24` 를 요구하므로 홀수 메이저(21, 23)는 제외됩니다.

> 검증 환경: Node v24.12.0 / npm 11.6.2

### 설치

```bash
npm install
```

### 실행

```bash
# dev
npm run start:dev

# production
npm run build
npm run start:prod
```

### 테스트

```bash
npm test           # 단위 테스트
npm run test:e2e   # e2e 테스트
npm run test:load  # 부하 시나리오
npm run test:cov   # 커버리지
```

### 환경 변수

| 이름       | 기본값     | 설명                                       |
| ---------- | ---------- | ------------------------------------------ |
| `PORT`     | `3000`     | HTTP 포트                                  |
| `LOG_FILE` | `logs.txt` | 요청 / 스케줄러 처리 로그를 남길 파일 경로 |

```bash
PORT=4000 npm run start:prod
```

## API 사용법

Swagger UI: http://localhost:3000/api

아래 예시는 실제 응답을 그대로 옮긴 것입니다. Base URL 은 `http://localhost:3000` 입니다.

### Job 스키마

| 필드              | 타입                                          | 설명                                                    |
| ----------------- | --------------------------------------------- | ------------------------------------------------------- |
| `id`              | `string` (uuid)                               | 서버가 생성합니다                                       |
| `version`         | `number`                                      | 낙관적 잠금용. 쓰기가 성공할 때마다 1 증가합니다        |
| `title`           | `string`                                      | 필수                                                    |
| `description`     | `string?`                                     | 선택                                                    |
| `status`          | `waiting \| pending \| completed \| canceled` | 아래 상태 전이 규칙 참고                                |
| `processingTime`  | `number`                                      | 처리에 걸리는 시간(초). 생성 시 서버가 1~20 중 정합니다 |
| `reservationTime` | `number`                                      | 처리 예약 시점(초)                                      |

`status` 와 `version`, 두 시간 값은 모두 서버가 정합니다. 요청 본문에 넣어도 `ValidationPipe` 의 `whitelist` 가 걸러냅니다.

### 낙관적 잠금 — 모든 쓰기에 `version` 이 필요합니다

`PATCH` 3종은 본문에 `version` 을 요구합니다. 조회 시점의 `version` 을 그대로 실어 보내면, 그 사이 다른 요청이나 스케줄러가 job 을 바꿨을 때 `409` 로 거절됩니다. 클라이언트는 다시 조회해서 재시도하면 됩니다.

### 작업 생성

```bash
curl -X POST http://localhost:3000/jobs \
    -H 'Content-Type: application/json' \
    -d '{"title":"리포트 생성","description":"월간 리포트"}'
```

```json
201 Created
{
  "id": "78eb86b0-8fa4-483a-94dc-f1ed26f71afc",
  "version": 1,
  "title": "리포트 생성",
  "description": "월간 리포트",
  "status": "waiting",
  "processingTime": 10,
  "reservationTime": 16
}
```

### 목록 조회

```bash
curl http://localhost:3000/jobs
```

```json
200 OK
[
  { "id": "6dbdae6c-...", "version": 1, "title": "리포트 생성", "status": "waiting", "processingTime": 12, "reservationTime": 33 },
  { "id": "78eb86b0-...", "version": 1, "title": "리포트 검토", "status": "pending", "processingTime": 10, "reservationTime": 16 }
]
```

### 검색

| 쿼리 파라미터 | 타입     | 설명                                       |
| ------------- | -------- | ------------------------------------------ |
| `title`       | `string` | **부분 일치**, 대소문자를 구분합니다       |
| `status`      | `enum`   | `waiting / pending / completed / canceled` |

두 파라미터는 **AND** 로 묶이고, 둘 다 생략하면 전체를 반환합니다.

```bash
curl -G http://localhost:3000/jobs/search \
    --data-urlencode 'title=리포트' \
    --data-urlencode 'status=waiting'
```

```json
200 OK
[
  { "id": "50138f5b-...", "version": 1, "title": "리포트 생성", "description": "월간 리포트", "status": "waiting", "processingTime": 10, "reservationTime": 45 },
  { "id": "7162d184-...", "version": 1, "title": "리포트 검토", "status": "waiting", "processingTime": 6, "reservationTime": 49 }
]
```

`/jobs/search` 는 `/jobs/:id` 보다 먼저 선언되어 있습니다. 순서가 반대면 `search` 가 `:id` 로 잡혀 `ParseUUIDPipe` 에서 400 이 납니다.

### 단일 조회

```bash
curl http://localhost:3000/jobs/6dbdae6c-5d5e-49c3-b0b9-94b03e1e04db
```

```json
200 OK
{
  "id": "6dbdae6c-5d5e-49c3-b0b9-94b03e1e04db",
  "version": 1,
  "title": "리포트 생성",
  "description": "월간 리포트",
  "status": "waiting",
  "processingTime": 12,
  "reservationTime": 33
}
```

### 수정 (`title` / `description`)

수정 가능한 필드는 `title` 과 `description` 뿐입니다. 둘 중 최소 하나는 있어야 합니다.

```bash
curl -X PATCH http://localhost:3000/jobs/6dbdae6c-... \
    -H 'Content-Type: application/json' \
    -d '{"version":1,"title":"리포트 생성 v2"}'
```

```json
200 OK
{
  "id": "6dbdae6c-...",
  "version": 2,
  "title": "리포트 생성 v2",
  "description": "월간 리포트",
  "status": "waiting",
  "processingTime": 12,
  "reservationTime": 33
}
```

응답은 변경된 job 전체입니다. 클라이언트가 재조회 없이 다음 요청의 `version` 을 이어서 쓸 수 있습니다.

낡은 `version` 으로 다시 보내면 거절됩니다.

```bash
curl -X PATCH http://localhost:3000/jobs/6dbdae6c-... \
    -H 'Content-Type: application/json' \
    -d '{"version":1,"title":"덮어쓰기 시도"}'
```

```json
409 Conflict
{ "statusCode": 409, "message": ["버전이 일치하지 않습니다. current=2, request=1"] }
```

처리중(`pending`)인 job 은 `version` 이 맞아도 수정할 수 없습니다.

```json
409 Conflict
{ "statusCode": 409, "message": ["처리중인 작업은 수정할 수 없습니다."] }
```

### 취소

`waiting` / `pending` 인 job 을 취소합니다.

```bash
curl -X PATCH http://localhost:3000/jobs/6dbdae6c-.../cancel \
    -H 'Content-Type: application/json' \
    -d '{"version":2}'
```

```json
200 OK
{ "id": "6dbdae6c-...", "version": 3, "title": "리포트 생성 v2", "status": "canceled", "processingTime": 12, "reservationTime": 33 }
```

```json
409 Conflict   // 이미 취소됐거나 완료된 경우
{ "statusCode": 409, "message": ["대기/처리중인 작업만 취소 가능합니다"] }
```

### 재대기

취소한 job 을 다시 대기열로 돌립니다.

```bash
curl -X PATCH http://localhost:3000/jobs/6dbdae6c-.../wait \
    -H 'Content-Type: application/json' \
    -d '{"version":3}'
```

```json
200 OK
{ "id": "6dbdae6c-...", "version": 4, "title": "리포트 생성 v2", "status": "waiting", "processingTime": 12, "reservationTime": 33 }
```

```json
409 Conflict   // canceled 가 아닌 경우
{ "statusCode": 409, "message": ["취소된 작업만 복구 가능합니다."] }
```

## 상태 전이 규칙

```
          스케줄러 선점              처리 완료
waiting ──────────────▶ pending ──────────────▶ completed
   ▲                       │
   │                       │ /cancel
   │ /wait                 ▼
   └───────────────────  canceled
           /cancel  (waiting 에서도 가능)
```

| 전이                    | 주체                | 조건                                               |
| ----------------------- | ------------------- | -------------------------------------------------- |
| `waiting` → `pending`   | 스케줄러            | 틱마다 1건. 동시 실행 상한에 여유가 있을 때        |
| `pending` → `completed` | 스케줄러            | 처리 완료 시점에 선점 `version` 이 그대로일 때     |
| `waiting` → `canceled`  | `PATCH /:id/cancel` | `version` 일치                                     |
| `pending` → `canceled`  | `PATCH /:id/cancel` | `version` 일치. 이미 도는 워커의 결과는 버려집니다 |
| `canceled` → `waiting`  | `PATCH /:id/wait`   | `version` 일치                                     |
| `pending` → `waiting`   | 스케줄러 (재기동)   | 선점 직후 프로세스가 죽은 경우 되돌립니다          |

`completed` 는 종착 상태라 어떤 전이도 허용하지 않습니다.

상태별로 허용되는 요청입니다.

| 상태        | `PATCH /:id` | `/cancel` | `/wait` |
| ----------- | ------------ | --------- | ------- |
| `waiting`   | O            | O         | X       |
| `pending`   | X            | O         | X       |
| `completed` | X            | X         | X       |
| `canceled`  | O            | X         | O       |

`pending` 에서 수정을 막은 이유는 작업 내용이 바뀌면 이미 돌고 있는 처리와 결과가 어긋나기 때문입니다. 반대로 취소는 `pending` 에서도 허용합니다.

## 에러 응답

발생 지점(DTO 검증 / 파이프 / 서비스)과 무관하게 한 가지 모양으로 통일했습니다. 전역 `AllExceptionsFilter` 가 `HttpException` 의 응답을 정규화합니다.

```json
{
  "statusCode": 409,
  "message": ["버전이 일치하지 않습니다. current=2, request=1"]
}
```

`message` 는 **항상 배열**입니다. `class-validator` 가 여러 건을 배열로 돌려주는데, 단일 메시지만 문자열로 주면 클라이언트가 두 가지 모양을 분기해야 해서 배열로 맞췄습니다.

| 코드  | 상황                                                | `message` 예시                                                          |
| ----- | --------------------------------------------------- | ----------------------------------------------------------------------- |
| `400` | 본문 검증 실패                                      | `["version must be a number conforming to the specified constraints"]`  |
| `400` | 변경할 필드가 없음                                  | `["변경할 데이터를 입력해주세요."]`                                     |
| `400` | `id` 가 uuid 형식이 아님                            | `["Validation failed (uuid is expected)"]`                              |
| `400` | `status` 가 허용값이 아님                           | `["status must be one of the following values: waiting, pending, ..."]` |
| `404` | 존재하지 않는 `id`                                  | `["Not Found"]`                                                         |
| `409` | `version` 불일치 (동시 수정 / 스케줄러가 먼저 변경) | `["버전이 일치하지 않습니다. current=2, request=1"]`                    |
| `409` | 현재 상태에서 허용되지 않는 전이                    | `["대기/처리중인 작업만 취소 가능합니다"]`                              |
| `500` | 예기치 못한 오류                                    | `["서버 오류가 발생했습니다."]`                                         |

4xx 는 정상적인 흐름이라 `logs.txt` 에 스택을 남기지 않고, 예상하지 못한 5xx 만 스택까지 기록합니다.

## 파일

| 경로                 | 설명                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------- |
| `data/jobs.json`     | 작업 데이터. 조회 확인용 샘플이 포함되어 있습니다                                     |
| `data/recovers.json` | 스케줄러가 작업을 선점할 때 남기는 스냅샷. 비정상 종료 후 재기동 시 복구에 사용됩니다 |
| `logs.txt`           | 모든 HTTP 요청과 스케줄러 처리 결과가 기록됩니다                                      |

## 코멘트

### API 설계

| Method   | Path               | 설명                          |
| -------- | ------------------ | ----------------------------- |
| `POST`   | `/jobs`            | 새 작업 생성                  |
| `GET`    | `/jobs`            | 작업 목록 조회                |
| `GET`    | `/jobs/search`     | 제목/상태로 검색              |
| `GET`    | `/jobs/:id`        | 단일 작업 조회                |
| `PATCH`  | `/jobs/:id`        | 작업 title / description 수정 |
| *`PATCH` | `/jobs/:id/cancel` | 작업 상태 수정 - 취소         |
| *`PATCH` | `/jobs/:id/wait`   | 작업 상태 수정 - 대기         |

- \* 작업 상태에 따라 작업 내용 및 상태 변경이 불가능하다고 가정 후 로직 분기에 맞춰 엔드포인트를 분리했습니다.

### 의도적으로 결정한 부분

1. Job

- 작업의 내용이 실제 동작하는 스크래핑 같은 작업으로 가정해 건당 처리 소요시간, 처리중 취소 가능으로 가정했습니다.
- 완료된 작업에 대해 변경 불가능 하도록 했습니다.

2. 스케쥴러의 처리 방식

- 틱을 1sec으로 주고 틱당 1개의 job을 물도록 설계.
- concurrency를 통해 동시 처리 개수 제한
- 멀티 인스턴스 환경에서도 단일 스케쥴러 동작 제한(구현 편의..)

### 데이터 처리

동시 요청 상황에서 데이터의 원자성을 확보하기 위해 mutex 처리를 하였고,
처리하는 동안 락 점유 시간이 길어져 상태값과 락 획득을 분리하여 낙관적 락과 상태 관리로 로직을 처리했습니다.

### 성능

`npm run test:load` 로 측정했습니다. 절대 수치는 머신·디스크에 따라 달라지므로 테스트는 수치를 단정하지 않고 리포트로만 출력하고, 단정하는 것은 **부하를 줘도 지켜져야 하는 불변식**입니다.

> 측정 환경: Node v24.12.0 / ext4. 테스트가 `os.tmpdir()` 를 쓰므로 `/tmp` 가 tmpfs 인 환경에서는 쓰기 수치가 더 높게 나옵니다.

| 시나리오                          | 동시성 | 처리량      | p50    | p95     |
| --------------------------------- | ------ | ----------- | ------ | ------- |
| `GET /jobs` (job 100개)           | 1      | 1,899 req/s | 0.5ms  | 0.7ms   |
| `GET /jobs` (job 100개)           | 10     | 2,336 req/s | 4.0ms  | 5.0ms   |
| `GET /jobs` (job 100개)           | 100    | 2,368 req/s | 18.7ms | 279.2ms |
| `POST /jobs`                      | 25     | 1,144 req/s | 20.4ms | 30.3ms  |
| `PATCH /jobs/:id` (서로 다른 job) | 50     | 995 req/s   | 49.4ms | 58.0ms  |

읽기와 쓰기의 차이가 그대로 드러납니다. `node-json-db` 는 파일을 **최초 1회만 읽어 메모리에 들고** 있으므로 조회는 디스크를 타지 않고, 반대로 모든 쓰기는 **메모리 전체를 직렬화해 파일을 통째로 다시 씁니다**. 즉 읽기는 데이터 크기와 거의 무관하고 쓰기는 전체 job 수에 비례합니다. 동시성을 100 까지 올려도 처리량이 더 늘지 않는 것도 같은 이유로, 라이브러리 내부의 전역 read-write 락이 쓰기를 직렬화하기 때문입니다.

#### 낙관적 잠금의 비용

같은 job 에 요청이 몰릴 때 충돌이 얼마나 쌓이는지 측정했습니다. 조회 → 수정 → 409 면 재조회 후 재시도하는 실제 클라이언트 흐름입니다.

| 동시성 | 성공 | 시도 | 충돌 | 충돌률 | 성공당 시도 |
| ------ | ---- | ---- | ---- | ------ | ----------- |
| 1      | 32   | 32   | 0    | 0.0%   | 1.00        |
| 4      | 32   | 80   | 48   | 60.0%  | 2.50        |
| 16     | 32   | 194  | 162  | 83.5%  | 6.06        |
| 32     | 32   | 242  | 210  | 86.8%  | 7.56        |

**동시성이 오르면 성공 1건당 시도 수가 선형에 가깝게 늘어납니다.** 낙관적 잠금은 경합이 드물다는 가정 위에서만 싼 방식이고, 단일 job 에 쓰기가 몰리는 워크로드에는 맞지 않습니다. 다만 이 과제에서는 서로 다른 job 에 대한 동시 수정이 일반적이고(경합 없는 수정 200건 = 409 **0건**), 한 job 에 몰리는 것은 예외적이라고 보고 선택했습니다.

중요한 것은 충돌이 나도 **데이터가 깨지지 않는다**는 점입니다. 부하 테스트가 단정하는 불변식은 다음과 같습니다.

- 같은 `version` 으로 동시에 200건이 몰려도 성공은 **정확히 1건**, 나머지는 전부 409
- 성공한 횟수만큼만 `version` 이 증가 — 잃어버린 갱신 없음
- 응답이 끝난 시점에 디스크 파일도 같은 상태
- 스케줄러가 도는 중에 취소가 몰려도 `recover` 찌꺼기가 남지 않음

## 고민했던 지점

### mutex 만으로는 부족했고, 낙관적 잠금만으로도 부족했습니다

처음에는 `PATCH` 쪽에 키별 mutex 만 걸었습니다. 그런데 스케줄러가 job 을 선점해 처리하는 동안 같은 락을 붙잡고 있으면, 그 job 에 대한 조회·수정 요청이 처리 시간(최대 20초)만큼 통째로 대기합니다. 락 점유 시간을 처리 시간과 분리해야 한다고 판단했습니다.

그래서 **역할을 나눴습니다.**

- **키별 mutex** — `조회 → 검증 → 쓰기` 구간만 감쌉니다. 실제 처리(`process()`)는 락 바깥에서 fire-and-forget 으로 돌기 때문에 락 점유 시간이 디스크 I/O 수준으로 짧습니다.
- **`version` 낙관적 잠금** — 오래된 스냅샷을 들고 온 클라이언트의 갱신을 막습니다.

둘 중 하나만으로는 안 됩니다. 낙관적 잠금만 있으면 `조회` 와 `쓰기` 사이에 다른 요청이 끼어들 수 있고, mutex 만 있으면 락을 얻기 전에 이미 낡아버린 요청을 걸러내지 못합니다. 막는 대상이 다릅니다.

### 선점한 워커가 자기 결과를 쓸 자격이 있는지

취소는 `pending` 에서도 허용하기로 했는데, 그러면 "워커가 아직 돌고 있는 job" 의 상태가 바뀔 수 있습니다. 여기서 두 가지 문제가 나왔습니다.

**첫째, 낡은 워커가 결과를 덮어씁니다.** 처리 중 취소 → (`canceled` 는 수정 가능하므로) 제목 수정 → 그 뒤 워커가 처리를 끝내면서 선점 시점 스냅샷으로 job 을 되돌려버렸습니다. 클라이언트는 `200 OK` 를 받은 수정이 몇 초 뒤 조용히 사라지는 것을 봅니다.

`getClaimJob` 이 `version` 을 1 올리므로, **선점 시점의 `version` 이 곧 그 워커의 소유권 증명**입니다. 결과를 커밋하기 직전에 현재 `version` 과 비교해서 다르면 아무것도 쓰지 않도록 했습니다. 재기동 복구(`onApplicationBootstrap`)에도 같은 검사를 넣었습니다. 그쪽은 `recover` 가 선점 **이전** 스냅샷이므로 `recover.version + 1` 이 티켓이 됩니다.

부수적으로 코드가 줄었습니다. `version` 이 같다는 것은 선점 이후 아무도 job 을 건드리지 않았다는 뜻이고, 상태를 바꾸는 모든 경로가 `version` 을 올리므로 **`version` 이 같으면 `status` 는 반드시 `pending`** 입니다. 상태별 분기가 전부 사라졌습니다.

**둘째, 같은 job 이 두 번 선점됩니다.** `pending → canceled → waiting` 이 가능한데, 이 왕복이 끝나면 "워커가 돌고 있다"는 사실이 디스크에서 지워집니다(`status` 가 다시 `waiting`). 다음 틱이 같은 job 을 또 선점해서 워커 두 개가 동시에 돌았습니다.

이 사실은 인메모리에만 있으므로, 스케줄러가 처리 중인 id 집합을 들고 선점 단계에서 거르도록 했습니다. 단일 인스턴스 전제와 한 쌍입니다.

### 비정상 종료에서 되살아나는 순서

선점은 `recover` 스냅샷을 **먼저** 남기고 그다음에 `status` 를 바꿉니다. 순서를 반대로 하면 그 사이에 죽었을 때 복구할 근거가 사라집니다. 완료·취소 처리도 마찬가지로 job 을 먼저 확정하고 `recover` 를 나중에 지웁니다. 어느 지점에서 죽어도 재기동 복구가 같은 결론에 도달하도록 맞췄습니다.

복구할 때 값은 되돌리지만 **`version` 은 되돌리지 않고 계속 올립니다.** 그래서 죽기 전 `version` 을 들고 있던 클라이언트는 재기동 후 자동으로 409 를 받습니다.

### 멀티 인스턴스 — 검토했지만 하지 않기로 했습니다

분산락(Redis 등)을 검토했습니다. 그런데 **락을 붙여도 성립하지 않습니다.**

`node-json-db` 는 `load()` 가 최초 1회만 실행되고 이후 조회는 프로세스 메모리에서 이뤄지며, 쓰기는 메모리 전체를 파일에 덮어씁니다. 인스턴스 A 가 만든 job 을 인스턴스 B 는 모르는 채로 자기 메모리를 파일에 쓰기 때문에, 필드 하나가 아니라 **파일 전체가 되돌아갑니다.** 분산락은 두 쓰기의 순서만 정해줄 뿐 이 문제와는 무관합니다. 매 연산마다 락 안에서 `reload()` 를 하면 해결되지만 요청마다 전체 파일을 다시 읽고 파싱하게 됩니다.

즉 **분산락 이전에 저장 계층 교체가 선행되어야 한다**고 판단했고, 과제가 요구한 동시성이 "API 요청과 스케줄러가 동시에 같은 데이터에 접근하는" 단일 프로세스 범위라는 점도 함께 고려했습니다. `isPrimary` 플래그는 그 결정을 코드에 남겨둔 자리입니다.

## 되돌린 결정

### 리커버 스냅샷을 통째로 복원하던 것

처음에는 재기동 시 `recover` 에 저장된 job 을 **전체 복사**해 되돌렸습니다. 상태별 전이 테이블(`pending → waiting`, `canceled → canceled`, 나머지는 복구 대상 아님)을 두고 분기했습니다.

문제는 이게 **사용자의 정당한 수정까지 지운다**는 것이었습니다. 취소된 job 은 수정이 허용되는데, 그 뒤 워커가 끝나거나 서버가 재기동되면 스냅샷이 수정을 덮었습니다.

`version` 비교로 바꾸고 나니, 선점은 `status` 만 바꾸므로 **스냅샷의 나머지 필드는 되돌릴 이유가 없다**는 것이 드러났습니다. 지금은 `status` 만 되돌립니다. 전이 테이블과 스냅샷을 펼치던 헬퍼가 통째로 사라졌습니다.

### 스케줄러 처리 단위

초기에는 "틱당 1건" 이라는 값만 있었고 근거가 없었습니다. 동시 실행 개수를 묶으려던 의도였지만, 처리가 fire-and-forget 이라 실제로 제한되는 것은 **유입 속도**였고 동시 실행 개수에는 상한이 없었습니다. 처리 중인 id 집합의 크기로 명시적인 상한을 두는 쪽으로 바꿨습니다. 지금은 손잡이가 두 개입니다 — 유입은 틱당 1건, 동시 실행은 최대 10건.

## 시간이 더 있다면

우선순위 순입니다.

1. **처리 실패 시 재시도와 격리.** 지금은 처리 중 예외가 나면 로그만 남고 job 이 `pending` 에 남아 재기동 전까지 다시 잡히지 않습니다. 실패 시 `waiting` 으로 되돌리고, 재시도 횟수를 **선점 시점에** 올려(그래야 프로세스가 죽는 실패도 집계됩니다) 상한을 넘으면 사람이 확인하는 상태로 격리하려 했습니다.
2. **원자적 파일 쓰기.** `node-json-db` 의 `FileAdapter` 는 `open(w)` 후 곧바로 쓰기 때문에 쓰는 도중 죽으면 JSON 이 잘린 채 남습니다. `IAdapter` 가 `readAsync` / `writeAsync` 두 메서드뿐이라, 임시 파일에 쓰고 `rename` 하는 어댑터로 교체할 수 있습니다. `Config` 의 `syncOnSave` 도 기본값이 `false` 라 켜야 합니다.
3. **`reservationTime` 을 실제로 사용.** 현재 값은 저장만 되고 스케줄러가 참조하지 않습니다. 예약 시각이 지난 job 만 선점하도록 하면 1번의 재시도 백오프도 이 필드로 표현할 수 있습니다. 이때 "서버 기동 후 n 초" 라는 상대값은 재기동하면 의미가 사라지므로 절대 시각으로 바꿔야 합니다.
4. **선점 배치화.** 지금은 job 하나를 선점할 때마다 `recovers.json` 과 `jobs.json` 을 각각 통째로 다시 씁니다. N 건을 한 번에 선점하면 2N 번이 2번으로 줄지만, 여러 id 의 mutex 를 동시에 잡아야 해서 획득 순서를 정하지 않으면 교착이 생깁니다.
5. **목록 페이지네이션.** `GET /jobs` 가 전체를 반환합니다.
