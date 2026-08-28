# AE Eyes sweep-1000 — the pattern search

1000 configurations swept across 5 images in 181.5s.

## Cross-image pattern — configs that rank in the top-10 on the most images

| Top-10 hits | Preproc | Binder | Postproc | Mean score | Min score | Max score |
|---:|---|---|---|---:|---:|---:|
| 2/5 | identity | density-cluster | merge_overlap | 0.877 | 0.700 | 1.000 |
| 2/5 | identity | density-cluster | keep_top_10 | 0.875 | 0.700 | 1.000 |
| 2/5 | identity | density-cluster | identity | 0.874 | 0.700 | 1.000 |
| 2/5 | identity | density-cluster | filter_tiny | 0.874 | 0.700 | 1.000 |
| 2/5 | gaussian_1 | density-cluster | identity | 0.845 | 0.689 | 1.000 |
| 2/5 | gaussian_1 | density-cluster | merge_overlap | 0.845 | 0.689 | 1.000 |
| 2/5 | gaussian_1 | density-cluster | filter_tiny | 0.845 | 0.689 | 1.000 |
| 2/5 | gaussian_1 | density-cluster | keep_top_10 | 0.845 | 0.689 | 1.000 |
| 2/5 | gaussian_1 | persistent-homology-lite | keep_top_10 | 0.814 | 0.535 | 1.000 |
| 2/5 | identity | region-grow | keep_top_10 | 0.708 | 0.000 | 1.000 |
| 2/5 | identity | region-grow | filter_tiny | 0.707 | 0.000 | 1.000 |
| 2/5 | gaussian_1 | region-grow | identity | 0.691 | 0.000 | 1.000 |
| 1/5 | gaussian_5 | density-cluster | merge_overlap | 0.891 | 0.700 | 1.000 |
| 1/5 | gaussian_5 | density-cluster | identity | 0.880 | 0.700 | 1.000 |
| 1/5 | gaussian_5 | density-cluster | filter_tiny | 0.880 | 0.700 | 1.000 |
| 1/5 | gaussian_5 | density-cluster | keep_top_10 | 0.880 | 0.700 | 1.000 |
| 1/5 | gaussian_2 | density-cluster | identity | 0.878 | 0.689 | 1.000 |
| 1/5 | gaussian_2 | density-cluster | merge_overlap | 0.878 | 0.689 | 1.000 |
| 1/5 | identity | persistent-homology-lite | keep_top_10 | 0.738 | 0.400 | 1.000 |
| 1/5 | gaussian_1 | region-grow | merge_overlap | 0.691 | 0.000 | 1.000 |

## Per-image top 5 (verify the pattern makes sense per image)


### fruits (multi-object close-up)

| Rank | Preproc | Binder | Postproc | N | Cov% | MaxBox% | Score |
|---:|---|---|---|---:|---:|---:|---:|
| 1 | identity | watershed | identity | 5 | 42.9 | 17.9 | 1.000 |
| 2 | identity | watershed | merge_overlap | 5 | 42.9 | 17.9 | 1.000 |
| 3 | identity | watershed | filter_tiny | 5 | 42.9 | 17.9 | 1.000 |
| 4 | identity | watershed | keep_top_10 | 5 | 42.9 | 17.9 | 1.000 |
| 5 | identity | region-grow | identity | 10 | 38.7 | 16.9 | 1.000 |

### baboon (textured single subject)

| Rank | Preproc | Binder | Postproc | N | Cov% | MaxBox% | Score |
|---:|---|---|---|---:|---:|---:|---:|
| 1 | gaussian_1 | persistent-homology-lite | filter_tiny | 9 | 25.6 | 19.1 | 1.000 |
| 2 | gaussian_1 | persistent-homology-lite | keep_top_10 | 10 | 26.0 | 19.1 | 1.000 |
| 3 | gaussian_5 | density-cluster | identity | 12 | 62.9 | 14.1 | 1.000 |
| 4 | gaussian_5 | density-cluster | merge_overlap | 12 | 62.9 | 14.1 | 1.000 |
| 5 | gaussian_5 | density-cluster | filter_tiny | 12 | 62.9 | 14.1 | 1.000 |

### messi5 (person in scene)

| Rank | Preproc | Binder | Postproc | N | Cov% | MaxBox% | Score |
|---:|---|---|---|---:|---:|---:|---:|
| 1 | identity | density-cluster | identity | 9 | 60.6 | 26.3 | 1.000 |
| 2 | identity | density-cluster | merge_overlap | 9 | 60.6 | 26.3 | 1.000 |
| 3 | identity | density-cluster | filter_tiny | 9 | 60.6 | 26.3 | 1.000 |
| 4 | identity | density-cluster | keep_top_10 | 9 | 60.6 | 26.3 | 1.000 |
| 5 | identity | predictive-error-grouping | keep_top_10 | 10 | 64.9 | 27.6 | 1.000 |

### home (indoor scene, clutter)

| Rank | Preproc | Binder | Postproc | N | Cov% | MaxBox% | Score |
|---:|---|---|---|---:|---:|---:|---:|
| 1 | identity | density-cluster | identity | 8 | 60.9 | 21.9 | 1.000 |
| 2 | identity | density-cluster | merge_overlap | 7 | 59.4 | 21.9 | 1.000 |
| 3 | identity | density-cluster | filter_tiny | 8 | 60.9 | 21.9 | 1.000 |
| 4 | identity | density-cluster | keep_top_10 | 8 | 60.9 | 21.9 | 1.000 |
| 5 | gaussian_1 | density-cluster | identity | 8 | 58.3 | 21.9 | 1.000 |

### starry_night (painterly / high-frequency)

| Rank | Preproc | Binder | Postproc | N | Cov% | MaxBox% | Score |
|---:|---|---|---|---:|---:|---:|---:|
| 1 | identity | region-grow | filter_tiny | 15 | 21.4 | 3.4 | 1.000 |
| 2 | identity | region-grow | keep_top_10 | 10 | 17.7 | 3.4 | 1.000 |
| 3 | gaussian_1 | region-grow | identity | 11 | 18.4 | 4.8 | 1.000 |
| 4 | gaussian_1 | region-grow | merge_overlap | 11 | 18.4 | 4.8 | 1.000 |
| 5 | gaussian_1 | region-grow | filter_tiny | 9 | 17.6 | 4.8 | 1.000 |
