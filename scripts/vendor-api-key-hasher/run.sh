#!/bin/bash

# Environment overrides can be passed as KEY=value arguments, e.g.
#   mu script vendor-login hash-vendor-api-keys GRAPH_URI=http://mu.semte.ch/graphs/vendors/
# mu-cli forwards the arguments after the command name to run.sh.

for arg in "$@"; do
  export "${arg%%=*}"="${arg#*=}"
done

npm install
npm run generate-migration