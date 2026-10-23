# Research: can Truss bundle the AWS Architecture Icons?

Ticket: #9 (see the Truss v1 map, #8). Researched 2026-10-22 against aws.amazon.com (the icons page, Site Terms, Trademark Guidelines), the downloaded icon package `Icon-package_07312026` and PowerPoint toolkit `Microsoft-PPTx-toolkits_07312026`, first-party GitHub repos (awslabs, mingrammer, pistazie, jgraph), the npm registry and `aws-cdk-lib@2.274.0`. The numbers in brackets point to the Sources list at the end. Counts marked **[measured]** come from unpacking the package and counting files. No downloaded code was run.

This is not legal advice. The licensing answer rests on reading AWS's published text, and that text is thin.

## TL;DR

- **Using the icons in architecture diagrams is clearly allowed.** The icons page says "We allow customers and partners to use these toolkits and assets to create architecture diagrams" [1]. A Preview SVG committed to a user's repo is an architecture diagram, so it is the use AWS names.
- **Redistributing the raw icon set inside an npm package is not explicitly granted, and not explicitly forbidden.** The package has **no licence file, README or terms** in it **[measured]**. The fallback is the AWS Site Terms, which give only a "limited license to access and make personal use" and bar "any derivative use", unless "otherwise specified by AWS in a separate license" [3]. The icons page is the only "separate" grant, and it covers making diagrams, not shipping the assets.
- **AWS itself redistributes the icons under CC-BY-ND 2.0.** The first-party `awslabs/aws-icons-for-plantuml` repo says "The icons provided in this package are made available to you under the terms of the CC-BY-ND 2.0 license" [6]. That is the clearest licence AWS has put on these images. It allows copying and redistribution with credit, and no modifications beyond format conversion.
- **The OSS ecosystem bundles them openly.** diagrams.py (MIT, ~42.8k stars) ships 556 AWS PNGs in-repo [8]. cdk-dia (MIT) ships AWS PNGs in its npm package [10]. draw.io (Apache-2.0) ships AWS stencils and says "we have verified that all original licenses permit use in this project" [12]. None of these carries an AWS-specific notice except draw.io's general one.
- **Recommendation:** bundle the **unmodified official SVGs**, curated to the services the Catalog covers, as a **separately licensed asset directory or package**, never relabelled Apache-2.0. Ship a NOTICE that credits AWS and names the CC-BY-ND 2.0 terms AWS uses in awslabs. Put a credit line inside every Preview SVG. Ask `trademarks@amazon.com` for written confirmation before 1.0 (a human task). Fall back to a generic icon from an OSS set (Lucide, ISC) for anything with no AWS icon.

## 1. Licence and terms

### 1.1 What AWS says

The icons page [1], verbatim:

> To help you build diagrams, this page has Amazon Web Services (AWS) product icons, resources, and tools you can use. We allow customers and partners to use these toolkits and assets to create architecture diagrams.
>
> AWS architecture icons are designed to be simple, so you can easily use them in diagrams. You can also put icons in materials like whitepapers, presentations, data sheets, and posters.
>
> You can build diagrams with preexisting libraries on third-party tools. Check that you're using up-to-date icons, because some libraries may contain legacy icon sets.

The page also lists third-party tools that include the icons, among them draw.io, Cloudcraft, Creately and Figma [1]. So AWS knows and accepts that diagramming tools ship the icons. It says nothing about the terms those tools ship them under.

The downloaded package (`Icon-package_07312026.zip`, 13.99 MB) holds only icon files plus macOS `__MACOSX`/`.DS_Store` debris. There is **no LICENSE, README, NOTICE or terms file** **[measured]**.

The PowerPoint toolkit [2] has no licence text either. Slide 5 repeats the grant: "Customers and partners can use AWS icons to create architecture diagrams. The icons are basic in design so that you can incorporate them directly into your whitepapers, presentations, datasheets, posters, or any technical material that you want." Every slide carries "© 2026, Amazon Web Services, Inc. or its affiliates." The deck's usage rules are design rules, not licence terms, but they show what AWS considers misuse:

- "Use icons at their predefined size, color and format in diagrams." "DON'T: Crop service icons. Flip or rotate icons. Change icon shapes." (slide 15)
- "All colors for icons have been accessibility tested and should not be altered" (slide 13)
- "DON'T: Create groups with nonapproved AWS icon(s). Resize group icons." (slide 14)
- "In certain AWS Regions (e.g., China), AWS does not own the rights for the logo using the letters 'AWS.'" Use the plain cloud group there (slide 25).

### 1.2 The default terms that apply when nothing else does

AWS Site Terms (last updated 2025-06-04) [3]:

> All content included on the AWS Site, such as text, graphics, logos, button icons, images, [...] is the property of AWS or its content suppliers and protected by United States and international copyright laws.

> AWS grants you a limited license to access and make personal use of the AWS Site and not to download (other than page caching) or modify it, or any portion of it, except with express written consent of AWS. This license does not include any resale or commercial use of the AWS Site or its contents; any derivative use of the AWS Site or its contents [...]. Unless otherwise specified by AWS in a separate license, your right to use any software, data, documentation or other materials that you access or download through the AWS Site is subject to these Site Terms [...]

> "Amazon Web Services" and all related marks, including logos, graphic designs, and service names, are trademarks or trade dress of AWS [...]. AWS's trademarks and trade dress may not be used in connection with any product or service that is not AWS's, in any manner that is likely to cause confusion among customers, or in any manner that disparages or discredits AWS.

AWS Trademark Guidelines (last updated 2026-07-17) [4]:

> **10. Trade Dress.** You will not imitate the trade dress or "look and feel" of any AWS website, including without limitation, the branding, color combinations, fonts, graphic designs, product icons, or other elements associated with AWS.

> **13. Fair Use.** AWS does not object to fair use of its marks by third parties, so long as the use would not be confusing for customers. Any such use should be in plain text only (no logos) [...]. Fair use does not permit you to state or imply affiliation, sponsorship, or endorsement by AWS.

> **15. Third Party Publications.** In most cases, AWS does not provide licenses or other authorization for use of AWS content in third party publications, including screenshots, diagrams, code, documentation, or other copyrightable materials. However, AWS does not object to limited fair use of such materials for educational or non-profit purposes.

Reading these together:
- The icon page's grant is the "separate license" for making diagrams. Truss's output is diagrams, so the Preview is covered.
- Shipping the icon files to every `npx truss` user is distribution, which the icon page doesn't mention and the Site Terms don't grant. It is a grey area, not a clear yes.
- Section 10 is a reason **not** to draw Truss's own look-alike icons. Redrawn AWS-style icons would "imitate [...] product icons" without the cover of the icon page's grant.

### 1.3 The one explicit redistribution licence: awslabs, CC-BY-ND 2.0

`awslabs/aws-icons-for-plantuml` is an AWS-owned repo (README header: "Copyright 2020 Amazon.com, Inc. or its affiliates") that is "generated from the official AWS Architecture Icons" [6]. Its License Summary says:

> The icons provided in this package are made available to you under the terms of the CC-BY-ND 2.0 license, available in the `LICENSE` file. Code is made available under the MIT license in `LICENSE-CODE`.

The repo ships 962 PNG/SVG files, mostly PNGs converted from the official set, and is still maintained (v23.1, 2026-09-01) [6][7]. The relevant CC-BY-ND 2.0 terms, from the repo's `LICENSE` [7]:

- **Allowed:** "to reproduce the Work, to incorporate the Work into one or more Collective Works", "to distribute copies [...] display publicly". This covers an npm package and a diagram.
- **Format conversion is allowed:** "The above rights include the right to make such modifications as are technically necessary to exercise the rights in other media and formats, but otherwise you have no rights to make Derivative Works." Inlining an SVG into another SVG, or rasterising it, is format conversion. Recolouring or reshaping it is not.
- **Collective Work:** a diagram that places the unmodified icon among other elements "will not be considered a Derivative Work".
- **Conditions:** "You must include a copy of, or the Uniform Resource Identifier for, this License with every copy [...] You may not sublicense the Work. You must keep intact all notices", and "give the Original Author credit reasonable to the medium".

Strictly, that grant covers the files in that repo, not the zip from aws.amazon.com. But it shows the terms AWS is willing to put on the same artwork, and those terms fit Truss: unmodified icons, redistributed with credit, inside a differently licensed work.

### 1.4 What this means for Truss

| Use | Verdict | What it needs |
|---|---|---|
| Icon embedded in a Preview SVG committed to a user's repo | **Allowed**: it is an architecture diagram [1]. | Unmodified icon at its predefined colours. A credit line in the SVG (see §5). |
| Icons shown on the canvas in the local app | **Allowed**: making diagrams [1]. | Same as above. |
| Icon files shipped inside the `truss` npm package | **Grey**: not granted by the icon page or Site Terms; matches CC-BY-ND 2.0 terms AWS uses elsewhere; widespread precedent (§4). | Keep them out of the Apache-2.0 grant. Ship a NOTICE with AWS copyright, source URL and the CC-BY-ND 2.0 URI. No modifications. Written confirmation from AWS would remove the doubt. |
| Labelling the icons Apache-2.0 / MIT | **Not allowed**: Truss can't sublicense what it doesn't own, and CC-BY-ND bars sublicensing. | Several npm packages do this (§4.4). Truss shouldn't copy them. |
| Recolouring, cropping, theming or re-drawing the icons | **Not allowed** (No Derivatives; deck slides 13 and 15; Trademark Guidelines §10). | Show dark-mode variants only where AWS ships them. |
| Using the AWS logo or implying endorsement | **Not allowed** [4] §13. | Describe Truss as "for AWS CDK" in plain text. Use the cloud-icon group, not the AWS-logo group, in China contexts [2] slide 25. |

## 2. Format, size, naming and release cadence

### 2.1 Package layout (release `07312026`) **[measured]**

```
Architecture-Service-Icons_07312026/Arch_<Category>/<16|32|48|64>/Arch_<Service>_<size>.{svg,png}   (+ _64@5x.png)
Resource-Icons_07312026/Res_<Category>/Res_<Service>_<Resource>_48.{svg,png}
Resource-Icons_07312026/Res_General-Icons/Res_48_{Light,Dark}/Res_<Thing>_48_{Light,Dark}.{svg,png}
Architecture-Group-Icons_07312026/<Group>_32[_Dark].{svg,png}
Category-Icons_07312026/Arch-Category_<16|32|48|64>/Arch-Category_<Category>_<size>.{svg,png}
```

| Set | SVG files | Notes |
|---|---|---|
| Service icons | 1,220 (305 per size × 4) | 303 distinct services; AWS Marketplace has Light and Dark variants. 25 category folders. |
| Resource icons | 513 | 466 light-background icons, plus 47 general icons in Light/Dark pairs. 48 px only. |
| Group icons | 15 | AWS Cloud (with/without logo, light/dark), Region, AWS account, VPC, Public/Private subnet, Auto Scaling group, Spot Fleet, Corporate data center, Server contents, EC2 instance contents, IoT Greengrass Deployment. |
| Category icons | 26 per size | e.g. Compute, Databases, Serverless, Storage, Networking-Content-Delivery. |

Total: 1,852 SVG and 2,183 PNG files, 16.5 MB unpacked.

### 2.2 The SVGs

- Plain SVG 1.1, exported from Sketch. Each file has a `<title>` and `id` attributes such as `Icon-Architecture/48/Arch_Amazon-DynamoDB_48`, but no `<style>` and no embedded raster images. 16 files use `url(#...)` gradients or masks **[measured]**.
- The size in the file name is **not** the canvas size. Service icons `_16`/`_32`/`_48`/`_64` have viewBoxes of 24, 40, 64 and 80 respectively. The extra space is padding. Resource icons `_48` have a 48×48 viewBox **[measured]**.
- A service icon is a coloured square with a white glyph. The fill colour comes from the category, for example `#C925D1` Databases, `#ED7100` Compute, `#7AA116` Storage, `#DD344C` Security, `#E7157B` Management, `#8C4FFF` Networking, `#01A88D` AI **[measured]**.
- Size: a single 48 service icon is about 3–6 KB. All 303 service icons at 48 come to 1.05 MB raw / 327 KB gzipped. All 466 light resource icons come to 1.46 MB raw / 436 KB gzipped **[measured]**. Bundling the full 48 set is cheap. A curated subset is cheaper.
- Two practical points for inlining many icons into one Preview SVG. Ids collide (every file has an `id="Rectangle"`), so Truss must prefix ids when inlining. A `<symbol>` + `<use>` per distinct icon keeps the Preview small when a service appears many times.

### 2.3 Naming

- Service: `Arch_<Brand>-<Service-Name>_<size>`, using the full marketing name with its `Amazon-`/`AWS-` prefix: `Arch_Amazon-DynamoDB_48`, `Arch_AWS-Lambda_48`, `Arch_Amazon-Simple-Storage-Service_48`, `Arch_Elastic-Load-Balancing_48`.
- Resource: `Res_<Service>_<Resource>_48`, e.g. `Res_AWS-Lambda_Lambda-Function_48`, `Res_Amazon-DynamoDB_Table_48`, `Res_Amazon-Simple-Storage-Service_Bucket_48`. Some instance-like icons skip the underscore: `Res_Amazon-Aurora-MySQL-Instance_48`.
- **Names are not stable or consistent.** Within one release, IAM is `Arch_AWS-Identity-and-Access-Management` but `Res_AWS-Identity-Access-Management_Role`, and there are typos such as `RDS-Instance-Aternate`. Across releases, folders get renamed: cdk-dia's bundled copy uses `Res_Networking-and-Content-Delivery` and `Arch_Networking-Content`, where the current release has `Res_Networking-Content-Delivery` and `Arch_Networking-Content-Delivery` [11]. Truss needs its own stable icon ids and a mapping file regenerated per release. It should not use AWS file names as keys.

### 2.4 Release cadence

> Architecture icon packages are released on a quarterly basis: Q1 (end of January), Q2 (end of April), and Q3 (end of July). No releases occur in Q4. [1]

The current package is dated 2026-07-31, and the deck calls it "Release 24-2026.07.31" [2]. Expect the next one at the end of January 2027. Download URLs are content-hashed (`.../Icon-package_07312026.<sha1>.zip`), so they change each release. Truss should vendor a pinned copy at build time, not fetch at runtime.

## 3. Mapping a construct to an icon

### 3.1 Namespace → service icon

`aws-cdk-lib@2.274.0` exports 341 `aws-*` service submodules (from `package.json` `exports`). The package has 303 service icons. A naive name match (lowercase, strip `Amazon`/`AWS`, compare to the namespace, also try initials) automatically matches **137** namespaces **[measured]**:

| Namespace | Auto-match |
|---|---|
| `aws_dynamodb` | `Arch_Amazon-DynamoDB` |
| `aws_lambda` | `Arch_AWS-Lambda` |
| `aws_sqs` | `Arch_Amazon-Simple-Queue-Service` (initials) |
| `aws_sns` | `Arch_Amazon-Simple-Notification-Service` (initials) |
| `aws_ecs`, `aws_eks`, `aws_ecr` | Elastic Container Service / Kubernetes Service / Container Registry |
| `aws_kms`, `aws_stepfunctions`, `aws_apigateway`, `aws_cloudfront`, `aws_cognito`, `aws_rds`, `aws_route53`, `aws_secretsmanager`, `aws_appsync`, `aws_kinesis`, `aws_cloudwatch`, `aws_ec2` | Direct |

Common ones the heuristic misses all have an icon, but need a hand-written entry:

| Namespace | Icon |
|---|---|
| `aws_s3` | `Arch_Amazon-Simple-Storage-Service` |
| `aws_iam` | `Arch_AWS-Identity-and-Access-Management` |
| `aws_events` | `Arch_Amazon-EventBridge` |
| `aws_elasticloadbalancingv2` | `Arch_Elastic-Load-Balancing` |
| `aws_ssm` | `Arch_AWS-Systems-Manager` |
| `aws_logs` | `Res_Amazon-CloudWatch_Logs` (a resource icon) |

So the mapping has to be a **curated data file**, checked into Truss and reviewed on each icon release and each `aws-cdk-lib` upgrade. The jsii assembly has no icon or marketing-name metadata (see `docs/research/jsii-metadata.md`). Auto-matching is good for producing the first draft of that file, not for running at runtime.

### 3.2 Construct → resource icon

The construct is a better key than the namespace for common L2s, because resource icons show the thing, not the service:

| Construct (FQN) | Icon |
|---|---|
| `aws_lambda.Function` | `Res_AWS-Lambda_Lambda-Function` |
| `aws_dynamodb.Table` / `TableV2` | `Res_Amazon-DynamoDB_Table` |
| `aws_s3.Bucket` | `Res_Amazon-Simple-Storage-Service_Bucket` |
| `aws_iam.Role` | `Res_AWS-Identity-Access-Management_Role` |
| `aws_elasticloadbalancingv2.ApplicationLoadBalancer` | `Res_Elastic-Load-Balancing_Application-Load-Balancer` |
| `aws_ec2.Vpc`, `Subnet` | Group icons `Virtual-private-cloud-VPC_32`, `Public-subnet_32` / `Private-subnet_32` |

cdk-dia does the same thing keyed by CloudFormation type. It holds a hand-written `awsResouceIconMatches.json` of `resourcePrefix` (`AWS::EC2`) → `specificResources[]` (`AWS::EC2::TransitGateway` → file) with a `genericFilePath` fallback per service, plus special cases that pick EC2/RDS instance icons from the instance-type family [11]. For Truss, an L2 resolves to its L1's CFN type via `tree.json` (`docs/research/import-feasibility.md` §2.1), so either key works. FQN is the natural key for the Catalog.

**Suggested lookup order:** construct FQN → resource or group icon; else namespace → service icon; else the namespace's category → category icon; else a generic icon.

### 3.3 What to show when there is no service icon

From the package itself **[measured]**:
- **Category icons** (26): good for a service with no icon of its own, coloured to match its family.
- **General resource icons** (47, Light and Dark): `Res_Generic-Application`, `Res_Gear`, `Res_Server`, `Res_Servers`, `Res_Database`, `Res_Data-Table`, `Res_Document`, `Res_Folder`, `Res_Logs`, `Res_Metrics`, `Res_Shield`, `Res_SSL-padlock`, `Res_Credentials`, `Res_User`/`Res_Users`, `Res_Client`, `Res_Internet`, `Res_Globe`, `Res_Source-Code`, `Res_JSON-Script`, `Res_Question`, and others. The deck says "General icons are flexible and their labels can be customized for your use-case" [2] slide 17.
- **Group icons** (15), including a generic group, for container constructs and Layers.

Non-AWS constructs (`constructs.Construct`, a user's own L3, a `CustomResource`, a third-party construct library) have no AWS icon. Use `Res_Generic-Application` or a Truss-owned icon (see §4.5), not an AWS service icon that would mislabel it.

## 4. How existing OSS tools handle it

### 4.1 diagrams.py (mingrammer/diagrams)

- MIT, ~42.8k stars, active (pushed 2026-10-17) [8].
- Ships **556 AWS PNGs** under `resources/aws/<category>/<name>.png` in the repo. `autogen.sh` uses Inkscape and ImageMagick to round and convert icons into PNGs [8].
- The repo has no icon-specific licence or credit. The README's licence section just says MIT. An open issue from 2020, "Licenses of icons" (#250), asks how contributors should attribute icon authors. It has never been answered by a maintainer [9].

### 4.2 cdk-dia (pistazie/cdk-dia)

- MIT, npm package, ~970 stars [10]. The closest analogue to Truss: it diagrams CDK apps from `tree.json`.
- `package.json` `files: ["dist", "icons"]`, so the npm tarball **ships AWS icon PNGs** (`icons/aws/...`, some re-rendered `_gen.png`). The repo has no icon licence or credit [10][11].
- The mapping is by CloudFormation type, hand-maintained, with per-service generic fallbacks (§3.2).

### 4.3 draw.io (jgraph/drawio)

- Apache-2.0 code. The AWS shapes ship as stencil libraries (`mxgraph.aws4.*`), not as the original files [12].
- README: "The icon sets, stencil libraries, and diagram templates are provided under the following terms", followed by a restriction against use in Atlassian products, and: "This restriction does not apply to end-user diagram output (such as exported images or documents) created using this software. Some icons are originally defined by third-party copyright holders; we have verified that all original licenses permit use in this project." [12]
- So draw.io also separates the asset terms from its Apache-2.0 code terms, and treats diagram output as the user's.

### 4.4 npm icon packages

- `aws-icons` / `aws-react-icons` (MKAbuMattar, 3.3.0, 2026-03) are labelled MIT on npm. The README says "AWS Architecture Icons are © Amazon Web Services, Inc., provided under the AWS icon terms. This repo and packages: MIT." [13] That is a reasonable credit pattern, but the npm `license: MIT` field misstates the icons' terms.
- `aws-svg-icons` (ISC, last published 2022, release 2021-07-30) is stale [13].
- Truss shouldn't depend on these. They add a middle-man and a misleading licence field, and lag AWS's releases. Vendoring from AWS directly is just as easy.

### 4.5 OSS alternatives, if AWS icons can't be used

No OSS project reproduces AWS service icons under an open licence, and making one would run into Trademark Guidelines §10. **Simple Icons** (CC0) has no Amazon or AWS icons at all **[measured]** in `simple-icons@16.35.0`. Its disclaimer says "Simple Icons is released under CC0 - though that doesn't mean to imply that all icons within the project are also CC0" [14].

The real alternative is generic, non-AWS-looking icons plus the service name as text, which the Trademark Guidelines allow as fair use [4] §13:

| Set | Licence | Version |
|---|---|---|
| Lucide (`lucide-static`) | ISC | 1.61.0 |
| Tabler Icons (`@tabler/icons`) | MIT | 3.49.0 |
| Material Symbols (`@material-symbols/svg-400`) | Apache-2.0 | 0.48.1 |
| Phosphor (`@phosphor-icons/core`) | MIT | 2.1.1 |

(npm registry, 2026-10-22.) Truss needs one of these anyway, for non-AWS constructs and UI chrome. It also makes a good fallback mode, `--no-aws-icons`, if AWS ever objects.

## 5. Recommended approach

1. **Vendor a pinned, curated subset at build time.** A script downloads the release zip and verifies its hash. It copies the **unmodified** 48 px service SVGs, resource SVGs, group and category icons that the Catalog's mapping file references. It writes them under a separate directory such as `assets/aws-architecture-icons/`, or into a separate package such as `@truss/aws-architecture-icons`. Expect well under 1 MB gzipped. Re-run it each quarter (end of Jan, Apr, Jul).
2. **Keep the icons outside the Apache-2.0 grant.** Put a `LICENSE`/`NOTICE` in that directory with these points:
   - "AWS Architecture Icons © Amazon Web Services, Inc. or its affiliates. All rights reserved."
   - The source: `https://aws.amazon.com/architecture/icons/`, release 2026-07-31.
   - AWS's grant: "We allow customers and partners to use these toolkits and assets to create architecture diagrams."
   - "Unmodified. Not covered by Truss's Apache-2.0 licence."
   - A pointer to CC-BY-ND 2.0 (`https://creativecommons.org/licenses/by-nd/2.0/`), the terms AWS publishes the same artwork under in awslabs/aws-icons-for-plantuml.

   Set the package's npm `license` field to something honest, such as `SEE LICENSE IN LICENSE`.
3. **Credit inside every Preview SVG.** Add a `<desc>` or `<metadata>` with the copyright line, source URL and licence URI. Also consider a small visible footer, which is "reasonable to the medium" for an image. This also lets anyone who copies the SVG out of the repo see where the icons came from.
4. **Never modify the icons.** Don't recolour them for themes, crop them or re-draw them. Only prefix ids and wrap them in `<symbol>` for inlining, which is format conversion. Use AWS's own Dark variants where they exist. On a dark canvas, the square service icons work as-is (the deck says they are "designed to be used on both light and dark backgrounds" [2] slide 15).
5. **Own the mapping.** Keep a checked-in `icon-map` from construct FQN / namespace to a Truss icon id to the AWS file, with the fallback chain in §3.2. Generate the first draft with the name heuristic and review it by hand. A unit test can fail the build if a Catalog construct has no entry or an entry points at a file that is missing from the vendored release.
6. **Plain-text branding only.** Use "Truss, a visual editor for AWS CDK", with no AWS logo, and nothing that implies endorsement [4] §13.
7. **Ask AWS (human task, `ready-for-human`).** Email `trademarks@amazon.com`, the contact the Trademark Guidelines give [4] §16. Ask for written confirmation that redistributing the unmodified icons in an Apache-2.0 OSS diagram tool, with the notice above, is acceptable. Until there's an answer, keep a Lucide fallback (`--no-aws-icons`) working, so the icons can be removed in one release if needed.

Open questions:
- Will AWS confirm in writing? This is the only thing that turns "grey but widely tolerated" into "allowed".
- Does the Truss package bundle the icons, or download them on first run from the AWS URL into the user's cache? The download route avoids redistribution entirely, but it needs network access, breaks on every release (the URLs are hashed), and Previews would still embed the icons. The recommendation is bundling, with the download route as the fallback if AWS says no.

## Sources

1. AWS Architecture Icons page, fetched 2026-10-22: https://aws.amazon.com/architecture/icons/ (package `https://d1.awsstatic.com/onedam/marketing-channels/website/public/shared/architecture-icon-release/Icon-package_07312026.5846e92413caa21490223536cc97f1269e44fa92.zip`)
2. AWS Architecture Icons PowerPoint toolkit, `AWS-Architecture-Icons-Deck_For-Light-BG_07312026.pptx`, in `Microsoft-PPTx-toolkits_07312026.1c286c4a809a3cf2902c88ff63bf7dd1fa3cd55d.zip` from [1]; slides 1, 2, 5, 13–15, 17, 25.
3. AWS Site Terms, last updated 2025-06-04: https://aws.amazon.com/terms/
4. AWS Trademark Guidelines, last updated 2026-07-17: https://aws.amazon.com/trademark-guidelines/ (§§10, 13, 15, 16)
5. `aws-cdk-lib@2.274.0` `package.json` `exports` (npm registry)
6. awslabs/aws-icons-for-plantuml README, License Summary: https://github.com/awslabs/aws-icons-for-plantuml
7. awslabs/aws-icons-for-plantuml `LICENSE` (CC-BY-ND 2.0 full text, §§3, 4) and releases (v23.1, 2026-09-01): https://github.com/awslabs/aws-icons-for-plantuml/blob/main/LICENSE
8. mingrammer/diagrams repo (MIT; `resources/aws/`; `autogen.sh`): https://github.com/mingrammer/diagrams
9. mingrammer/diagrams issue #250 "Licenses of icons" (2020-08-13, open): https://github.com/mingrammer/diagrams/issues/250
10. pistazie/cdk-dia repo and `package.json` (MIT; `files: ["dist","icons"]`): https://github.com/pistazie/cdk-dia
11. cdk-dia `src/diagram/aws/aws-icon-supplier.ts` and `awsResouceIconMatches.json`: https://github.com/pistazie/cdk-dia/tree/master/src/diagram/aws
12. jgraph/drawio README, License section: https://github.com/jgraph/drawio
13. npm registry: `aws-icons`, `aws-react-icons` (https://github.com/MKAbuMattar/aws-icons README), `aws-svg-icons`
14. simple-icons `DISCLAIMER.md`: https://github.com/simple-icons/simple-icons/blob/develop/DISCLAIMER.md
