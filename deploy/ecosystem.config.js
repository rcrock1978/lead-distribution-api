/** PM2 topology — three processes on one VPS (PRD §18).
 *  Clone layout: <home>/apps/api and <home>/apps/web side-by-side.
 *  instances:1 is LOAD-BEARING: serialized assignment + per-process state.
 *  NOTE: PM2 does NOT expand `~` in cwd/script — resolve $HOME here.
 */
const homedir = require('os').homedir();
const API = `${homedir}/apps/api`;
const WEB = `${homedir}/apps/web`;

module.exports = {
  apps: [
    { name: 'lead-api',    cwd: API, script: 'dist/main-api.js',
      instances: 1, exec_mode: 'fork', max_memory_restart: '300M', time: true },
    { name: 'lead-worker', cwd: API, script: 'dist/main-worker.js',
      instances: 1, exec_mode: 'fork', max_memory_restart: '200M',
      exp_backoff_restart_delay: 200, time: true },
    { name: 'lead-web',    cwd: WEB, script: 'node_modules/next/dist/bin/next',
      args: 'start', instances: 1, exec_mode: 'fork',
      max_memory_restart: '400M', time: true,
      env: { NODE_ENV: 'production', PORT: '8316' } },
  ],
};
