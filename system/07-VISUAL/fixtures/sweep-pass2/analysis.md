# Sweep Pass 2 — winners × 19 images

152 experiments in 168.3s.

## Cross-image winner ranking

| Config | Top-1 | Top-3 | Top-5 | Mean rank | Mean score |
|---|---:|---:|---:|---:|---:|
| gaussian_2+density-cluster+merge_overlap | 12/19 | 15/19 | 16/19 | 2.1 | 0.828 |
| identity+density-cluster+merge_overlap | 3/19 | 15/19 | 17/19 | 3.2 | 0.853 |
| gaussian_2+density-cluster+identity | 0/19 | 14/19 | 17/19 | 2.9 | 0.828 |
| gaussian_1+density-cluster+merge_overlap | 2/19 | 4/19 | 6/19 | 5.7 | 0.855 |
| identity+density-cluster+identity | 0/19 | 3/19 | 15/19 | 4.3 | 0.851 |
| median_3+density-cluster+merge_overlap | 0/19 | 3/19 | 14/19 | 5.1 | 0.800 |
| median_5+density-cluster+merge_overlap | 2/19 | 3/19 | 6/19 | 5.4 | 0.804 |
| median_3+density-cluster+identity | 0/19 | 0/19 | 4/19 | 7.3 | 0.802 |

## Per-image best config

| Image | Best config | Score |
|---|---|---:|
| fruits | gaussian_2+density-cluster+merge_overlap | 1.000 |
| baboon | identity+density-cluster+merge_overlap | 0.874 |
| messi5 | gaussian_2+density-cluster+merge_overlap | 1.000 |
| home | gaussian_2+density-cluster+merge_overlap | 1.000 |
| starry_night | gaussian_2+density-cluster+merge_overlap | 0.750 |
| lena | median_5+density-cluster+merge_overlap | 0.772 |
| apple | gaussian_2+density-cluster+merge_overlap | 1.000 |
| orange | median_5+density-cluster+merge_overlap | 0.994 |
| building | gaussian_2+density-cluster+merge_overlap | 0.750 |
| basketball1 | gaussian_2+density-cluster+merge_overlap | 1.000 |
| pic1 | gaussian_2+density-cluster+merge_overlap | 0.800 |
| pic2 | gaussian_1+density-cluster+merge_overlap | 0.812 |
| pic5 | gaussian_2+density-cluster+merge_overlap | 0.755 |
| pic6 | gaussian_2+density-cluster+merge_overlap | 1.000 |
| butterfly | identity+density-cluster+merge_overlap | 0.841 |
| board | gaussian_1+density-cluster+merge_overlap | 1.000 |
| basketball2 | gaussian_2+density-cluster+merge_overlap | 1.000 |
| gradient | gaussian_2+density-cluster+merge_overlap | 0.749 |
| notes | identity+density-cluster+merge_overlap | 0.720 |
