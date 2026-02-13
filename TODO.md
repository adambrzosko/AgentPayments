
## TO DO
* Write a comprehensive test script to hit any/all of the deployments. 
* Get some more serious botfinding working. Maybe? Or is curl blocking enough. 
* Move to mainnet
* Build a scalable payment verification path (do not do this yet): move chain scanning out of middleware and into a background indexer/subscriber that watches only merchant USDC ATA(s), records memo→paid in DB/Redis, and lets middleware do fast O(1) lookups instead of live `getParsedTransaction` fan-out.


#### Vendor UI
* A website where a vendor enters their bank details, verifies their ownership of the resource

