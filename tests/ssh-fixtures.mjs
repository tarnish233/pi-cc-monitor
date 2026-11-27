/** A private fake ssh CLI: executes the production fixed reader locally, never contacts a host. */
import fs from 'node:fs';
import path from 'node:path';

export function fakeSsh(t, cwd, { ignoreTerm = false } = {}) {
  const bin = path.join(cwd, 'fake-ssh-bin'); fs.mkdirSync(bin, { mode: 0o700 });
  const capture = path.join(cwd, 'ssh-arguments.json');
  const script = `#!${process.execPath}\n` + [
    "const fs=require('node:fs'),{spawn}=require('node:child_process');",
    "const args=process.argv.slice(2);fs.writeFileSync(process.env.PI_TEST_SSH_CAPTURE,JSON.stringify(args));",
    ignoreTerm ? "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);" : '',
    "const child=spawn('/bin/sh',['-c',args.at(-1)],{stdio:'inherit'});",
    "child.on('error',()=>process.exit(1));",
    ignoreTerm ? "child.on('close',()=>{});" : "child.on('close',code=>process.exit(code??1));",
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(bin, 'ssh'), script, { mode: 0o700 });
  const oldPath = process.env.PATH, oldCapture = process.env.PI_TEST_SSH_CAPTURE;
  process.env.PATH = bin + path.delimiter + (oldPath ?? ''); process.env.PI_TEST_SSH_CAPTURE = capture;
  t.after(() => { process.env.PATH = oldPath; if (oldCapture === undefined) delete process.env.PI_TEST_SSH_CAPTURE; else process.env.PI_TEST_SSH_CAPTURE = oldCapture; });
  return { bin, capture, host: 'fixture-host' };
}
