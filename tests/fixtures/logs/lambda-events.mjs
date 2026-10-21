// Trimmed CloudWatch Logs payloads copied from AWS Lambda log output.
// Kept as JS so the fixture stays readable without a JSON escaping layer.

const coldId = '11111111-1111-4111-8111-111111111111';
const warmId = '22222222-2222-4222-8222-222222222222';
const errorId = '33333333-3333-4333-8333-333333333333';
const timeoutId = '44444444-4444-4444-8444-444444444444';
const oomId = '55555555-5555-4555-8555-555555555555';

export const cold = [
  { timestamp: 1000, message: 'INIT_START Runtime Version: nodejs:20.v101\tRuntime Version ARN: arn:aws:lambda:us-east-1::runtime:abc' },
  { timestamp: 1129, message: 'START RequestId: ' + coldId + ' Version: $LATEST' },
  { timestamp: 1130, message: '2026-10-21T20:00:00.000Z INFO boot' },
  { timestamp: 1131, message: 'END RequestId: ' + coldId },
  { timestamp: 1131, message: 'REPORT RequestId: ' + coldId + '\tDuration: 2.58 ms\tBilled Duration: 119 ms\tMemory Size: 1024 MB\tMax Memory Used: 67 MB\tInit Duration: 115.86 ms' },
];

export const warm = [
  { timestamp: 6000, message: 'START RequestId: ' + warmId + ' Version: $LATEST' },
  { timestamp: 6001, message: '2026-10-21T20:01:00.000Z INFO hello' },
  { timestamp: 6002, message: 'END RequestId: ' + warmId },
  { timestamp: 6002, message: 'REPORT RequestId: ' + warmId + '\tDuration: 1.20 ms\tBilled Duration: 2 ms\tMemory Size: 1024 MB\tMax Memory Used: 67 MB' },
];

export const failure = [
  { timestamp: 7000, message: 'START RequestId: ' + errorId + ' Version: $LATEST' },
  { timestamp: 7001, message: '2026-10-21T20:02:00.000Z ERROR Invoke Error {"errorType":"Error","errorMessage":"boom"}' },
  { timestamp: 7002, message: 'ERROR Error: boom' },
  { timestamp: 7003, message: 'END RequestId: ' + errorId },
  { timestamp: 7003, message: 'REPORT RequestId: ' + errorId + '\tDuration: 5.00 ms\tBilled Duration: 5 ms\tMemory Size: 1024 MB\tMax Memory Used: 68 MB\tStatus: error\tError Type: Error' },
];

export const timeout = [
  { timestamp: 8000, message: 'START RequestId: ' + timeoutId + ' Version: $LATEST' },
  { timestamp: 8001, message: '2026-10-21T20:03:00.000Z INFO waiting' },
  { timestamp: 11001, message: '2026-10-21T20:03:03.000Z Task timed out after 3.00 seconds' },
  { timestamp: 11002, message: 'END RequestId: ' + timeoutId },
  { timestamp: 11002, message: 'REPORT RequestId: ' + timeoutId + '\tDuration: 3000.00 ms\tBilled Duration: 3000 ms\tMemory Size: 1024 MB\tMax Memory Used: 70 MB\tStatus: error\tError Type: Runtime.ExitError' },
];

export const oom = [
  { timestamp: 12000, message: 'START RequestId: ' + oomId + ' Version: $LATEST' },
  { timestamp: 12001, message: '2026-10-21T20:04:00.000Z Runtime exited with error: signal: killed' },
  { timestamp: 12002, message: 'END RequestId: ' + oomId },
  { timestamp: 12002, message: 'REPORT RequestId: ' + oomId + '\tDuration: 1500.00 ms\tBilled Duration: 1500 ms\tMemory Size: 128 MB\tMax Memory Used: 128 MB' },
];
