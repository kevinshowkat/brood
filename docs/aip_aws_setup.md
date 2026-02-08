# AIP On AWS (Step By Step, AWS-Noob Friendly)

This repo ships:
- `llms.txt` + `agent-intake.json` (agent-facing discovery surfaces)
- `scripts/aip_build_packs.py` (builds JSON context packs)
- `scripts/aip_lambda_handler.py` (prod-friendly Lambda handler)

To actually **track** usage, you need an HTTPS endpoint agents can reach (`POST /aip/intake`) and a place to serve packs (optional but recommended). The simplest AWS setup is:

- **S3 (private)** stores packs (and optionally `agent-intake.json`)
- **Lambda Function URL** exposes:
  - `POST /aip/intake`
  - `GET /aip/packs/<file>.json` (served from S3)
- **CloudWatch Logs** stores structured telemetry (intake + pack fetches)

This avoids CloudFront/WAF/API Gateway at first. You can add those later.

## 0) Prereqs
1. You have an AWS account and can access the AWS Console.
2. Pick a region and stick to it (example: `us-east-1`).

## 1) Build Packs Locally (Optional But Recommended)
From the repo root:
```bash
python3 scripts/aip_build_packs.py --all --out-dir outputs/aip_packs --write-index
ls outputs/aip_packs
```

You should see files like:
- `outputs/aip_packs/index.json`
- `outputs/aip_packs/desktop-quick-actions.json`

## 2) Create An S3 Bucket (Private)
In AWS Console:
1. Go to **S3**.
2. Click **Create bucket**.
3. Bucket name: something globally unique, e.g. `brood-aip-prod-<yourname>`.
4. Region: same region you’ll deploy Lambda in.
5. Keep **Block all public access** enabled (recommended).
6. Click **Create bucket**.

Upload files:
1. Open the bucket.
2. Create a folder (prefix) named `packs/`.
3. Upload all JSON files from `outputs/aip_packs/` into `packs/`:
   - `packs/index.json`
   - `packs/<tag>.json`
4. Also upload `agent-intake.json` to the bucket root (key `agent-intake.json`).
   - This lets you update tag catalogs without redeploying Lambda.

## 3) Create The Lambda Function
In AWS Console:
1. Go to **Lambda**.
2. Click **Create function**.
3. Choose **Author from scratch**.
4. Function name: `brood-aip`
5. Runtime: **Python 3.12** (or newest available).
6. Click **Create function**.

Add the handler code:
1. In the function page, go to the **Code** tab.
2. Replace the contents of `lambda_function.py` with the contents of `scripts/aip_lambda_handler.py`.
3. At the bottom, click **Deploy**.

Set env vars:
1. Go to **Configuration** -> **Environment variables** -> **Edit**.
2. Add:
   - `AIP_BUCKET` = your bucket name (e.g. `brood-aip-prod-...`)
   - `AGENT_INTAKE_KEY` = `agent-intake.json`
   - `PACKS_PREFIX` = `packs/`
   - (Optional) `PUBLIC_BASE_URL` = leave empty for now
3. Click **Save**.

## 4) Allow Lambda To Read From S3
In AWS Console:
1. In the Lambda function page, go to **Configuration** -> **Permissions**.
2. Click the **Role name** (opens IAM).
3. Click **Add permissions** -> **Create inline policy**.
4. Switch to **JSON** and paste (edit bucket name):
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject"],
      "Resource": "arn:aws:s3:::YOUR_BUCKET_NAME/*"
    }
  ]
}
```
5. Click **Next** -> name it `BroodAipS3Read` -> **Create policy**.

## 5) Create A Public HTTPS Endpoint (Lambda Function URL)
In AWS Console:
1. In the Lambda function page, go to **Configuration** -> **Function URL**.
2. Click **Create function URL**.
3. Auth type: **NONE** (public endpoint; required if you want arbitrary agents to call it).
4. Configure CORS:
   - Allow origin: `*`
   - Allow methods: `GET, POST` (and `OPTIONS` if the UI lists it)
   - Allow headers: `content-type, x-brood-opt-out`
5. Click **Save**.

Copy the Function URL. It looks like:
`https://<id>.lambda-url.<region>.on.aws`

Your AIP endpoint will be:
`https://<id>.lambda-url.<region>.on.aws/aip/intake`

## 6) Update The Repo To Point At Your Endpoint
Edit `agent-intake.json`:
- Set `intake_endpoint` to your Function URL + `/aip/intake`.

Example:
```json
{
  "intake_endpoint": "https://<id>.lambda-url.us-east-1.on.aws/aip/intake"
}
```

Commit and push so agents can discover the endpoint via `llms.txt` / the native instruction files.

## 7) Test It
Health check:
```bash
curl -sS https://<id>.lambda-url.<region>.on.aws/healthz
```

Intake:
```bash
curl -sS -X POST https://<id>.lambda-url.<region>.on.aws/aip/intake \
  -H 'Content-Type: application/json' \
  --data '{"schema_version":"aip-1","agent":{"tool":"codex","tool_version":"local"},"task":{"tags":["desktop-quick-actions"]}}' \
  | python3 -m json.tool
```

Then fetch a returned `packs[].url` (if packs were issued).

## 8) Where The Tracking Shows Up
Go to **CloudWatch** -> **Logs** -> log group `/aws/lambda/brood-aip`.

You’ll see structured JSON lines like:
- `type=aip_intake` (session creation + tags)
- `type=aip_pack_get` (pack downloads, joinable via `sid`)

Tip: in **Logs Insights**, you can run queries like:
```sql
fields @timestamp, @message
| filter @message like /\"type\":\"aip_intake\"/
| stats count() as intakes by bin(1d)
```

## 9) Hardening (Do Later)
If the endpoint gets noisy:
- Put **API Gateway** in front for throttling.
- Add **AWS WAF** for rate-based rules.
- Add a lightweight “bot tax” (reject missing/invalid `schema_version`, unknown tags, etc.).

If you need private packs:
- Keep S3 private (as above). Packs are only accessible via the Lambda endpoint.
