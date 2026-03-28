# Visibility Tracking

This file lists a small set of repo visibility metrics.

## Main metric

`unprompted_mention_rate`

- Numerator: results that mention Brood when the query did not include `brood`
- Denominator: all results where the query did not include `brood`

## Supporting metrics

- `prompted_mention_rate`
- `external_unique_referrers_total`
- channel-level uniques
- clone-to-view ratios

## Weekly routine

1. Collect probe results.
2. Pull the latest GitHub traffic snapshot.
3. Compute the metrics.
4. Log the weekly values and any large changes.
