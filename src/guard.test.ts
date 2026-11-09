import { test, assert } from 'orca/testing'
import { isOrcaMainCommand } from './guard.ts'

const HELPER = '/Applications/Orca.app/Contents/Frameworks/Orca Helper.app/Contents/MacOS/Orca Helper'
const MAIN = '/Applications/Orca.app/Contents/MacOS/Orca'
const yes = (cmd: string) => isOrcaMainCommand(cmd, HELPER, 'darwin')

test('the main executable, alone or with --flags, is the main process', () => {
  assert.ok(yes(MAIN))
  assert.ok(yes(`${MAIN} --remote-debugging-port=9333`))
  assert.ok(yes(`${MAIN} --foo --bar=1`))
})

test('Node-mode children of the main process are not it', () => {
  assert.equal(yes(`${MAIN} -e \nconst { spawn } = require('node:child_process')`), false)
  assert.equal(yes(`${MAIN} /tmp/some/script.js`), false)
  assert.equal(yes(`${MAIN} /tmp/script.js --flag`), false)
})

test('other programs and other bundles are not it', () => {
  assert.equal(yes('/bin/zsh'), false)
  assert.equal(yes(HELPER), false)
  assert.equal(yes('/Applications/Other.app/Contents/MacOS/Orca'), false)
  assert.equal(yes(`/tmp/evil/Applications/Orca.app/Contents/MacOS/Orca`), false)
  assert.equal(yes(''), false)
})

test('outside macOS the parent must be the very same executable', () => {
  assert.ok(isOrcaMainCommand('/opt/orca/orca', '/opt/orca/orca', 'linux'))
  assert.ok(isOrcaMainCommand('/opt/orca/orca --no-sandbox', '/opt/orca/orca', 'linux'))
  assert.equal(isOrcaMainCommand('/opt/orca/orca /tmp/x.js', '/opt/orca/orca', 'linux'), false)
  assert.equal(isOrcaMainCommand('/usr/bin/node', '/opt/orca/orca', 'linux'), false)
})
