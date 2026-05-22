# Ownership Maze

Sample command:

```sh
./build/ownership_maze sample-input.txt
```

This corpus case intentionally contains multiple ownership-loss paths:
- early return after allocation
- field overwrite without releasing old ownership
- partial cleanup failure in batch construction
- saturated queue path dropping owned payload
- disabled subscriber clone loss
- buggy teardown paths
