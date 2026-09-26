# QA test run — Ranger test session

Session `660c4420-8610-4f2d-bad0-84c6f1a29750`, deal TEST-0001, dealer 3-306,
2027 Polaris Ranger Crew XP 1000 Cab, VIN 4XARSM994V8046456.
All buyer data on this session is invented: Testcase Rider, Parkersburg WV
26101, lienholder "Test Finance Co". `is_test` is true, so nothing here can
trigger a Zoho write-back.

Set your secret once:

```sh
export FNI_SECRET='...'          # the FNI_WEBHOOK_SECRET value
export FNI=https://fovccigwlcmmzfubpfny.supabase.co/functions/v1
```

## 1. Rate

This is the step that was missing. The earlier QA rate went to TecAssured
directly from Postgres, so nothing was ever written to `fni.rated_offers` —
and `fni-contract-submit` reads the quote from that table. Run this first or
the submit answers "No rated offer found for this session."

```sh
curl -sS -X POST "$FNI/fni-rate-vehicle" \
  -H "x-webhook-secret: $FNI_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"660c4420-8610-4f2d-bad0-84c6f1a29750"}' \
  | tee rate.json | head -c 400
```

Expect `"status":"Rated"` and `"product_count":11`. The whole 78KB quote comes
back in `offer`; `head -c 400` just keeps your terminal readable.

## 2. Submit one contract

Battery Standard, the cheapest single-rate product in the quote: 120 months,
$0 deductible, dealer cost $95, no provider markup and no mandatory
surcharges. `retail_price` is set to $95, exactly at the cap, so the provider
cannot refuse it on price.

Pull the two ids out of the rate you just ran rather than trusting the ones
below — they are from last night's quote and TecAssured is free to renumber:

```sh
python3 - <<'PY' < rate.json
import json,sys
q=json.load(sys.stdin)["offer"]["quote"]
for v in q["vehicles"]:
    for p in v["products"]:
        if len(p["rates"])==1 and p["ptype"]=="BAT":
            r=p["rates"][0]
            print(p["label"], "product_unique=",p["unique"],
                  "rate_unique=",r["unique"],
                  "dealerCost=",r["dealerCost"]["amount"])
PY
```

```sh
curl -sS -X POST "$FNI/fni-contract-submit" \
  -H "x-webhook-secret: $FNI_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{
        "session_id": "660c4420-8610-4f2d-bad0-84c6f1a29750",
        "selections": [
          {
            "product_unique": "755_6",
            "rate_unique": "34348",
            "option_uniques": [],
            "retail_price": 95
          }
        ]
      }'
```

Expect `"status":"Agreement Created"` with one entry under `contracts`,
carrying a `contract_number`.

## 3. Pull the document

```sh
curl -sS -X POST "$FNI/fni-contract-documents" \
  -H "x-webhook-secret: $FNI_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"660c4420-8610-4f2d-bad0-84c6f1a29750"}' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); d.setdefault("documents",[]); [doc.update({"pdf_base64":"<%d bytes>" % len(doc.get("pdf_base64") or "")}) for doc in d["documents"]]; print(json.dumps(d, indent=2))'
```

The base64 PDF is replaced with its size so the output stays readable. What
matters is `signature_map`: two lines for one contract, buyer and seller.

## 4. Then tell me

Post the three responses here (or just say they worked) and I will check
`fni.agreements`, `fni.selected_products` and `fni.agreement_products`, then
void the contract.

There is no `fni-contract-void` Edge Function — voiding is deliberately not
exposed over HTTP. I will do it from the database side using the contract
number, the same way the last test contract was voided.
