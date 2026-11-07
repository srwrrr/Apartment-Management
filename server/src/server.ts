import { config } from './config';
import { createApp } from './app';
import { startJobs } from './jobs';

createApp().listen(config.PORT, () => {
  console.log(`API listening on http://localhost:${config.PORT}`);
  startJobs();
});
