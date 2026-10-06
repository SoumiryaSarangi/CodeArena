import sys
data = sys.stdin.read().split()
print(len(set(data[1:1 + int(data[0])])))
