# AE Eyes sweep 50 — ranked results on fruits.jpg

Image: 512x480, generated in 93109ms.

| Rank | Config | Preproc | Binder | Postproc | N | Cov% | MaxBox% | Score |
|---:|---|---|---|---|---:|---:|---:|---:|
| 1 | c01_identity_watershed_identity | identity | watershed | identity | 5 | 42.9 | 17.9 | 1.000 |
| 2 | c02_identity_watershed_merge_overlap | identity | watershed | merge_overlap | 5 | 42.9 | 17.9 | 1.000 |
| 3 | c05_identity_region-grow_identity | identity | region-grow | identity | 10 | 38.7 | 16.9 | 1.000 |
| 4 | c06_identity_region-grow_merge_overlap | identity | region-grow | merge_overlap | 8 | 37.3 | 16.9 | 1.000 |
| 5 | c11_gaussian_1_watershed_identity | gaussian_1 | watershed | identity | 10 | 58.5 | 17.3 | 1.000 |
| 6 | c12_gaussian_1_watershed_merge_overlap | gaussian_1 | watershed | merge_overlap | 5 | 58.3 | 17.3 | 1.000 |
| 7 | c35_median_3_region-grow_identity | median_3 | region-grow | identity | 7 | 23.5 | 16.9 | 1.000 |
| 8 | c36_median_3_region-grow_merge_overlap | median_3 | region-grow | merge_overlap | 7 | 23.5 | 16.9 | 1.000 |
| 9 | c43_log_normalize_density-cluster_identity | log_normalize | density-cluster | identity | 8 | 57.9 | 18.8 | 1.000 |
| 10 | c44_log_normalize_density-cluster_merge_overlap | log_normalize | density-cluster | merge_overlap | 8 | 57.9 | 18.8 | 1.000 |
| 11 | c33_median_3_density-cluster_identity | median_3 | density-cluster | identity | 6 | 17.9 | 5.0 | 0.834 |
| 12 | c34_median_3_density-cluster_merge_overlap | median_3 | density-cluster | merge_overlap | 6 | 17.9 | 5.0 | 0.834 |
| 13 | c15_gaussian_1_region-grow_identity | gaussian_1 | region-grow | identity | 6 | 13.3 | 5.9 | 0.800 |
| 14 | c16_gaussian_1_region-grow_merge_overlap | gaussian_1 | region-grow | merge_overlap | 6 | 13.3 | 5.9 | 0.800 |
| 15 | c03_identity_density-cluster_identity | identity | density-cluster | identity | 5 | 12.9 | 5.0 | 0.797 |

## Overlay images

Top-3 overlay PNGs to visually verify:
1. `fixtures/binder-sweep-50/c01_identity_watershed_identity-overlay.png` (score 1.000)
2. `fixtures/binder-sweep-50/c02_identity_watershed_merge_overlap-overlay.png` (score 1.000)
3. `fixtures/binder-sweep-50/c05_identity_region-grow_identity-overlay.png` (score 1.000)
