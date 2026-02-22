# Mother Gold Data Seed Checklist

Use this to build a fast starter dataset for proposal training and scoring.

## Put Files Here

- `images/gold_data_seed/people`
- `images/gold_data_seed/objects`
- `images/gold_data_seed/places`

The script expects at least 1 image in each folder. Recommended: 15-30 per folder.

## Download This Mix

### People (`images/gold_data_seed/people`)

Download portrait and action shots across:

- close-up face portrait
- full-body street style
- athlete mid-action
- chef/barista in workspace
- musician with instrument
- child playing
- elderly person portrait
- wedding/formal fashion portrait
- office professional at desk
- group candid photo

### Objects (`images/gold_data_seed/objects`)

Download isolated and contextual shots of:

- vintage camera
- neon sign
- skateboard
- bicycle
- flowers bouquet
- fruit close-up
- ceramic mug
- laptop keyboard
- toy figurine
- mechanical watch
- sneakers
- old TV or radio

### Places (`images/gold_data_seed/places`)

Download wide and medium shots of:

- modern city street
- cozy cafe interior
- subway station
- beach at sunset
- mountain landscape
- forest path
- desert road
- library interior
- museum/gallery room
- rooftop skyline
- grocery aisle
- old alley with texture

## Suggested Sources (royalty-free / permissive)

- Unsplash
- Pexels
- Pixabay
- Wikimedia Commons

## Run The Batch Script

```bash
python3 scripts/mother_gold_data_batch.py --init-dirs
python3 scripts/mother_gold_data_batch.py --sets 10 --modes hybridize,mythologize,transcend --interactive-score --open-preview
```

Outputs are written under:

- `outputs/mother_gold_data/<batch_id>/gold_scores.csv`
- `outputs/mother_gold_data/<batch_id>/runs/...`
- `outputs/mother_gold_data/<batch_id>/payloads/...`
