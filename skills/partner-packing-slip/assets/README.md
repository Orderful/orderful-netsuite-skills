# Assets

Deploy both files into the customer's SDF account-customization project:

| File | Destination |
|---|---|
| `orderful_renderPackingSlip_RL.js` | `src/FileCabinet/SuiteScripts/orderful-packing-slip/` |
| `customscript_orderful_render_packslip_rl.xml` | `src/Objects/` |

Add both paths to the project's `deploy.xml` (`<files>` and `<objects>` respectively),
then `suitecloud project:deploy`.

An `advancedpdftemplate` object additionally requires **both** `<scriptid>.xml` and
`<scriptid>.template.xml` listed in `deploy.xml`, and the manifest must declare
`<feature required="true">ADVANCEDPRINTING</feature>`.

These are a stopgap. The durable home for this capability is a native action on the
SuiteApp's agent RESTlet — see the skill's "Known gap" section.
