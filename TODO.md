
## TO DO
* Get sites hosted
  * Figure out why django deployment is blocking human traffic
  * Deploy to cloudflare and with nodejs
* Package bot blocking, bot communication, and talking to our servers into a "library" (mockup via file import is fine)
  * Improve bot communication - right now ChatGPT doesn't see the msg
* Figure out how to implement into the three deployments
* Flesh out our backend ...
* Write a comprehensive test script to hit any/all of the deployments. 



## Ultimate goals

#### Vendor Payment Rails
* A GitHub repo which a vendor simply pip installs, drops a few lines of code in their codebase, and bosh. 
  * Clankers are blocked and told to pay
  * Any payments are received to our wallet
    * for now, converting to cash and sending to vendors manually is fine
    * may even make sense to send them small amounts of our own money to improve word of mouth

#### Vendor UI
* A website where a vendor enters their bank details, verifies their ownership of the resource

#### Agent wallet
* A USDC/Solana wallet that 
* More as a demonstration to the ecosystem 
* This will probably be harder technically than the actual product, at least for an MVP
