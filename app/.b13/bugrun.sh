#!/bin/bash
# usage: .b13/bugrun.sh <BUG_MODE> <port>   → runs full suite against a fresh container with that BUG_MODE
cd /workspace/plans/egov-eservice/app
B=$1; PORT=$2; TAG=${B//,/_}
NAME=egov-bug-$TAG
docker rm -f $NAME >/dev/null 2>&1
rm -rf .b13/bugdata/$TAG; mkdir -p .b13/bugdata/$TAG
docker run -d --name $NAME -p $PORT:3000 -e TEST_MODE=1 -e BUG_MODE=$B -e DB_PATH=/data/egov.db -e TZ=Asia/Bangkok \
  -v $PWD/.b13/bugdata/$TAG:/data egov-eservice:latest >/dev/null
until curl -sf localhost:$PORT/api/health >/dev/null; do sleep 1; done
docker logs $NAME 2>&1 | grep BUG_MODE > .b13/bug-$TAG.txt
PLAYWRIGHT_BROWSERS_PATH=$PWD/.b13/pw BASE_URL=http://localhost:$PORT DB_PATH=$PWD/.b13/bugdata/$TAG/egov.db \
  node node_modules/@playwright/test/cli.js test --reporter=line --output=.b13/tr-$TAG >> .b13/bug-$TAG.txt 2>&1
docker rm -f $NAME >/dev/null 2>&1
