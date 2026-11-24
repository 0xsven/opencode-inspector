import { createApp } from './app.js';
const port = 4317;
const app = createApp();
const server = app.listen(port, '127.0.0.1', () => console.log(`OpenCode Inspector API${process.env.NODE_ENV === 'production' ? ' + app' : ''}: http://127.0.0.1:${port}`));
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  // app's close wrapper terminates and awaits the indexing child and removes its
  // unpublished files before invoking this callback.
  server.close(error => { process.exitCode = error ? 1 : 0; });
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
