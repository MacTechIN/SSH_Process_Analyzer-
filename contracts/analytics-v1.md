# Analytics v1

## 현재 현황

현재 현황은 각 host의 `publishedGeneration`이 가리키는 process만 사용한다.

- 사용자 이름: process `ownerName`
- 사용자별 현재 작업 수: `ownerName`별 process 수
- 작업 유형별 현재 작업 수: 서버가 재계산한 `taskType`별 process 수
- 미분류 작업 수: `classificationStatus=unclassified` process 수
- 서버별 부하: current process의 CPU 합계와 메모리 합계

## 기간별 통계

기간별 통계는 snapshot history에서 bounded query로 계산하거나 후속 aggregate 저장소에서 계산한다. MVP 구현 방식과 보존 기간은 Phase 0 성능 검증 후 결정한다.

- 시간 구간: UTC 기준 고정 bucket, bucket 크기는 Phase 0에서 확정
- 사용자별 실행 작업 수 추이: bucket별 `ownerName` 기준 process 수
- 작업 유형별 점유율: bucket별 `taskType` 기준 process 수와 비율
- 장시간 실행 Top 10: `capturedAt - processStartAt` 내림차순

현재 현황과 기간별 통계 모두 OS process 소유주 이름을 사용하며 별도 사용자 매핑은 하지 않는다.
