# Mother Gold Data Seed Checklist

Use this checklist when building a starter image set for Mother evaluation.

## Folder layout

Put images in:

- `images/gold_data_seed/people`
- `images/gold_data_seed/objects`
- `images/gold_data_seed/places`

The script expects at least one image in each folder. A small mixed set works better than a very narrow one.

## Suggested image mix

People:
- portraits
- full-body photos
- action shots

Objects:
- consumer products
- household objects
- textured objects

Places:
- indoor scenes
- outdoor scenes
- wide and medium shots

## Suggested sources

- Unsplash
- Pexels
- Pixabay
- Wikimedia Commons

## Batch command

```bash
python3 scripts/mother_gold_data_batch.py --init-dirs
python3 scripts/mother_gold_data_batch.py --sets 10 --modes hybridize,mythologize,transcend --interactive-score --open-preview
```

## Output location

- `outputs/mother_gold_data/<batch_id>/gold_scores.csv`
- `outputs/mother_gold_data/<batch_id>/runs/...`
- `outputs/mother_gold_data/<batch_id>/payloads/...`
