#!/bin/bash

trap "exit" INT

files=$(node scripts/dry_run.js | awk -F$'\t' '{ print "s3://" $1 "/" $2 }' | grep -v 'ccg-glycomics-data/glycoproteome' )

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

for file in $files; do
	echo -e "$GREEN$file$NC"
	aws s3 cp "$file" - | head -3 | cut -c -120
done