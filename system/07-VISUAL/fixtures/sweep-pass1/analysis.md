# Sweep Pass 1 — analysis

500 experiments (50 configs × 10 images) in 258.5s.

## Universal configs (top-10 on all 10 images)

**None.** No config lands in top-10 across every image.

## Near-universal (top-10 on ≥8 images)



## Winners chosen for Pass 2 (top 8)

1. gaussian_2 + density-cluster + merge_overlap — top-10 7/10, mean 0.897
2. gaussian_2 + density-cluster + identity — top-10 6/10, mean 0.897
3. identity + density-cluster + merge_overlap — top-10 6/10, mean 0.872
4. identity + density-cluster + identity — top-10 6/10, mean 0.870
5. median_3 + density-cluster + merge_overlap — top-10 6/10, mean 0.848
6. median_5 + density-cluster + merge_overlap — top-10 5/10, mean 0.860
7. gaussian_1 + density-cluster + merge_overlap — top-10 5/10, mean 0.859
8. median_3 + density-cluster + identity — top-10 4/10, mean 0.859
