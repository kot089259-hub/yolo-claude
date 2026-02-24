---
description: How to deploy the application to Render
---

1. Commit the changes to git
// turbo
2. Push to the `video-editor` remote (NOT `origin` or `zettai`):
```bash
git push video-editor main
```
3. Render will auto-deploy from `ZETTAI-INC/video-editor.git`
4. After deploy, verify at `https://<domain>/health`
