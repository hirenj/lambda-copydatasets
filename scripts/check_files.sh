#!/bin/bash

trap "exit" INT

files=$(node scripts/dry_run.js | awk -F$'\t' '!/^#/ { print "s3://" $1 "/" $2 FS $4 } /#/ { print }' | grep -v 'ccg-glycomics-data/glycoproteome' )

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

IFS=$'\n'

while IFS=$'\t' read -r -a fileinfo
do
	file="${fileinfo[0]}"
	changed="${fileinfo[1]}"
	if [ "$file" != "" ]; then
		echo -e "$GREEN$file$NC updated on $GREEN$changed$NC"
		aws s3 cp "$file" - | head -5 | cut -c -120
	fi
done < <(echo -e "$files" | grep -v '^#')

echo "$files" | grep '^#'