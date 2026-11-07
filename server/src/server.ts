import { config } from './config';
import { createApp } from './app';

createApp().listen(config.PORT, () => {
  console.log(`API listening on http://localhost:${config.PORT}`);
});
