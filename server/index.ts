import { createApp } from './app.js';
const port = 4317;
const app = createApp();
app.listen(port, '127.0.0.1', () => console.log(`OpenCode Inspector API${process.env.NODE_ENV === 'production' ? ' + app' : ''}: http://127.0.0.1:${port}`));
