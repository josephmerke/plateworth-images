# Plateworth image generator: how to run it from an iPhone

## What this is
A small program that reads image-inventory.csv, asks OpenAI to draw each picture (medium quality), crops it to 4:3 and saves it under the exact file name in the CSV (plus the -1200 and -480 sizes the app wants). It runs on GitHub's computers, not on your phone, so your phone only taps buttons.

## Safety rules built in
- It does nothing costly unless you untick "Dry run". Dry run lists what it would make and costs nothing.
- It never overwrites a picture that exists. To redo one you must type its exact id in "force_ids". The old copy is kept in assets/food/_replaced/.
- Each run makes at most the batch size you type (hard cap 25).
- Every attempt, good or bad, is written to assets/food/generation-log.jsonl.
- It stops after 3 failures in a row, or at once if OpenAI refuses the key or billing.
- Your key is stored only as a GitHub secret. It is never in the code, the log or the chat.
- Rows that share a picture are skipped. dish:fruit-and-nuts is skipped until its CSV row is fixed (it lists no foods).

## One-time setup (about 15 minutes, all in Safari)
1. OpenAI: platform.openai.com > Settings > Billing > set a monthly spending limit. Then create a new API key in a new project. Copy it, but do not paste it in the chat. If OpenAI says image models need "organization verification", complete that first.
2. GitHub: github.com, sign up (free) if needed. Tap + > New repository. Name it plateworth-images. Choose Private. Tick "Add a README". Create.
3. Add the 3 plain files: in the repo tap Add file > Upload files. Choose generate-images.js, package.json and image-inventory.csv from the Files app. Tap Commit changes.
4. Add the workflow: Add file > Create new file. In the name box type exactly  .github/workflows/generate-food-images.yml  (typing the slashes makes the folders). Open generate-food-images.yml, copy everything, paste it in the big box. Commit changes.
5. Save your key: repo > Settings > Secrets and variables > Actions > New repository secret. Name: OPENAI_API_KEY. Secret: paste your key here (on GitHub, not in the chat). Add secret.

## Every time you want pictures
1. Repo > Actions > "Generate food images" > Run workflow.
2. First run: leave "Dry run" ticked, batch 3. Tap Run workflow. Open the run and read the summary. It lists the next 3 images and spends nothing.
3. Happy? Run again with "Dry run" unticked and batch 1. Look at the picture in the repo (assets/food). Check cost in OpenAI's usage page.
4. Then use bigger batches (5, 10) as your budget allows.
Options: priority 1 = dishes, 2 = recipes, 3 = ingredients. only_ids = a list like dish:protein-shake,dish:breakfast-burrito. force_ids = redo these exact ids.

## Getting the pictures into the app
Later: on github.com open the repo, Code > Download ZIP, and attach the ZIP here. I will check it, set have:true in the manifest and build v59. Nothing is wired into the app by this tool.

## Notes
- The model is gpt-image-1 at medium quality, 1536x1024, cropped to 1600x1200. To use another model, add a repository variable OPENAI_IMAGE_MODEL (Settings > Secrets and variables > Actions > Variables).
- Check OpenAI's current price for your model before big batches. I have not verified current prices.
- Runs are one at a time, so two taps cannot double-spend.
