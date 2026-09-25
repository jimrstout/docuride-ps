# TecAssured Shop API Services Documentation

## Introduction
The TecAssured Shop API provides data integration services to connect front-end sales portals and menu to back-end administration systems. 

## Credentials
Contact `operations@tecassured.com` for issuance of test and production credentials.

## Base URLs
| Type | Environment | URL |
| --- | --- | --- |
| Rest Services | `test` | `ratessys-qa.com/rs/` |
| WSDL Services | `test` | `ratessys-qa.com/ws/` |
| Rest Services | `production` | `ratessys.com/rs/` |
| WSDL Services | `production` | `ratessys.com/ws/` |

## Examples
Examples are used throughout this document to demonstrate the services.

* **Code:** All code examples in this document are in `Java`, unless otherwise noted.
* **Data:** All data markup examples are in `JSON`, unless otherwise noted.

## 1\. Authentication

This section outlines the multi-step process for authenticating with the TecAssured Shop API Services using a username and password. The steps require the use to two different security endpoints, plus some client-side code to prevent secrets from being transmitted in plain text.

### 1.1. Login Request

The `loginrequest` endpoint initiates the authentication process by providing a **nonce**, **digest type**, and **salt** needed for generating a secure token.

**Endpoint:** `POST /auth/loginrequest`

**Request Body:**

Send your username in JSON format.

```json
{
    "username": "apiTest"
}
```

**Response Body:**

You will receive a response containing the nonce, digest type, and salt, regardless of whether the provided username is valid. The nonce is generated per request and is valid for 30 seconds

```json
{
    "nonce": "P7bGsg2FOuUsP0IcHbyOzyvOGknWVC",
    "digest": "PBKDF2",
    "salt": "c97d5ebd5b54985a247b43254ac488eb"
}
```

### 1.2\. Password Hashing

Using the `digest` and `salt` values provided by the `loginrequest` endpoint, hash the credentials using client-side code. 

* For **PBKDF2 (Password-Based Key Derivation Function 2)**, use **1000 iterations** to generate your hash. 
* The derived key length should be **64 \* 8 bits**, or eight times the hash length.

Here's an example of this process in Java:

```java
PBEKeySpec spec = new PBEKeySpec(password.toCharArray(), salt, iterations, 64 * 8);
SecretKeyFactory skf = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA1");
byte[] hash = skf.generateSecret(spec).getEncoded();
```

In this code snippet:

  * **`password`**: This refers to the password for the account you are attempting to log in with.
  * **`salt`**: This is the salt sent back from the `loginrequest` response.
  * **`iterations`**: Set this value to `1000`.
  * **`64 * 8`**: This specifies the bit length of the derived key.

Next, you will need to use the `hash` value to create a `token` using a hex algorithm.

```java
{
    String token = "";
    for ( int i = 0 ; i < hash.length ; i++ ) {
        token += Integer.toString( ( hash[ i ] & 0xff ) + 0x100, 16 ).substring( 1 );
    }
}
```

The result of this step is the `token` value, which you will use to login in the next step.

### 1.3. Login Assertion

Using the `token` value and the `nonce` from the previous step, you can now log in:

**Endpoint:** `POST /auth/loginassertion`

**Request Body:**

```json
{
    "nonce": "P7bGsg2FOuUsP0IcHbyOzyvOGknWVC",
    "token": "682adcca963ed177ff492ec82f851ee25095ebd8c824f87bec0d229e5d8cacecbf795105a4e55360e6a8df7fe091d3505ad3b12c362c4f8b376b44bd7eb5e244"
}
```

**Success Response:**

Upon successful completion of this process, you will receive a response containing the **`fullName`**, **`sessionId`** and an **`identifier`** (which is the userId).

```json
{
    "fullName": "API Test User",
    "sessionId": "f30ff0a6-e91e-4423-b56f-54e7b1cb7178",
    "identifier": 2703
}
```

  * An **`identifier`** of **-1** indicates that the login request was unsuccessful.
  * The **`sessionId`** will also be returned as a **cookie** for ease of use in subsequent requests.
  * **All future requests to the API will require this `sessionId`** in order to be processed. The **`sessionId`** is valid for 30 minutes and will need to be regenerated if expired. This 30 minute expiration timer will be refreshed upon using the sessionId in a request.

## 2\. VIN Decode

This endpoint provides basic information about a vehicle by decoding its VIN, such as the Year, Make, and Model.

> **Note:** This feature is only available if the dealer code supports this function; otherwise, no results will be returned.

**Endpoint:** `POST /decode`

**Request Body:**

```json
{
    "sessionId":"{{sessionID}}",
    "dealerCode": "1-304",
    "vin": "4XASHY573RA138166",
    "vtype": "ATV"
}
```

## 3\. VIN Decode Powersports

This endpoint provides basic information about a vehicle by decoding the VIN specifically for powersports vehicles.

> **Note:** This feature is only available if the dealer code supports this function; otherwise, no results will be returned.

**Endpoint:** `POST /decode/ps`

**Request Body:**

```json
{
    "sessionId":"{{sessionID}}",
    "dealerCode": "1-304",
    "vin": "4XASHY573RA138166",
}
```


**Response Body:**

The response will contain basic information about the VIN if the dealer supports the vehicle type and can successfully decode the VIN.

```json
{
    "year": "2024",
    "make": "Polaris",
    "model": "Sportsman 570",
    "displacement": "567"
}
```

-----

## 4\. DMS Lookup

The `DMSLookup` endpoint allows you to retrieve deal jacket information from a specified DMS (Dealer Management System).

For this endpoint you will need to provide:
  * **`dmsSystem`**: The specific DMS you would like to query (e.g., "lightspeed").
  * **`dmsDealNumber`**: The ID for the deal jacket you wish to look up within the given `dmsSystem`.

> **Note:** This feature is only available if the dealer code supports this function; otherwise, no results will be returned.

> **Note:** A list of supported `dmsSystem` values is available by request.

**Endpoint:** `POST /dmslookup`

**Request Body:**

```json
{
    "sessionId":"{{sessionID}}",
    "dealerCode": "1-304",
    "dmsSystem": "lightspeed",
    "dmsDealNumber": "15001"
}
```

**Response Body:**

```json
{
    "serial": "57XAATHD0N8152628",
    "odometer": "0",
    "saledate": "",
    "inservicedate": "2023-10-03",
    "vehicleprice": "23500",
    "cashfinance": "Finance",
    "financeamount": "29410.23",
    "financeterm": "60",
    "financeapr": "10.74",
    "financemonthly": "635.64",
    "msrp": "23500.0",
    "buyerzip": "78109",
    "modelYear": "2022",
    "model": "Slingshot S with Technology Package I",
    "vin": "57XAATHD0N8152628",
    "vtype": "MCYC",
    "dealNumber": "15001",
    "newUsed": "U",
    "year": "2022",
    "UnitSoldPrice": "23500",
    "make": "POLARIS",
    "FirstName": "Jane",
    "MiddleName": "E",
    "LastName": "Doe",
    "Address1": "9030 TRUMPET CIRCLE",
    "City": "CONVERSE",
    "State": "TX",
    "EMail": "test@gmail.com",
    "Zip": "78109",
    "MobilePhone": "2105555555"
}
```

## 5\. Rate Requests

This endpoint allows you to request rates for a specific vehicle and product configuration.

**Endpoint:** `POST /rate`

**Request Body:**

```json
{
    "dealerCode": "1-304",
    "sessionId":"f30ff0a6-e91e-4423-b56f-54e7b1cb7178",
    "financeAmount":"23000",
    "remainingMWM":"7",
    "financeTerm":"72",
    "financeType":"Purchase",
    "financeApr":"6",
    "odometer":"321",
    "productType":"All",
    "vehiclePrice":"23000",
    "purchaseType":"New",
    "rateDate":"2025-03-17",
    "vin":"5YFBURHE6JP837778",
    "vtype":"AUTO",
    "vehiclePurchaseDate":"2025-05-17",
    "saleDate":"2025-05-17",
    "inServiceDate":"2025-05-17",
    "vehicleStatus":"New",
    "customerCity":"Pickerington",
    "customerState":"OH",
    "customerCountry":"US",
    "customerPostalCode":"43147",
    "displacement":"431",
    "fuelType": "G",
    "properties"[
        { 
          "name" :"aspiration",
          "value": "N"
        },
        { 
          "name" :"msrp",
          "value": "25000"
        }
    ]
}
```

## 6\. Get Vehicle Properties

Returns a list of required or available properties for a specific vehicle type and dealer configuration. Use this to determine which data points need to be collected for the transaction.

**Request Body:**

**Endpoint:** `POST /rate/requiredproperties`


```json
{
    "sessionId": "f30ff0a6-e91e-4423-b56f-54e7b1cb7178",
    "dealerCode": "1-304",
    "vtype": "ATV"
}

```

| Field | Type | Description |
| --- | --- | --- |
| **sessionId** | `string` | The active session token obtained from the Auth endpoint. |
| **dealerCode** | `string` | The unique identifier for the dealership. |
| **vtype** | `string` | The vehicle type (e.g., ATV, AUTO, BOAT). |

---

**Response Body:**

The response contains an array of property objects defining the schema for the selected vehicle type.

**Example Response:**

```json
{
    "properties": [
        {
            "name": "vin",
            "description": "VIN",
            "type": "STRING"
        },
        {
            "name": "year",
            "description": "Year",
            "type": "STRING"
        },
        {
            "name": "price",
            "description": "Vehicle Price",
            "type": "DECIMAL"
        }
    ]
}

```

### 6.1\. Property Data Types

The following types are returned in the property definitions to guide your form validation:

| Type | Description |
| --- | --- |
| **STRING** | Alphanumeric text. |
| **DECIMAL** | Floating point numbers (typically used for currency or rates). |
| **INTEGER** | Whole numbers (used for terms, odometer, or counts). |
| **DATE** | Standard date format (YYYY-MM-DD). |

---


### 6.2\. Quote Request & Vehicle Specification

This table documents the parameters used to calculate the available rates and terms for the specific vehicle and customer.

| Field | Type | Access | Description |
| --- | --- | --- | --- |
| **`sessionId`** | `string` | Editable | The unique GUID identifying this specific API session. |
| **`dealerCode`** | `string` | Editable | The identifier for the dealership (e.g., `3-296`). |
| **`financeAmount`** | `decimal` | Editable | Total amount being financed (e.g., **23,000**). _(Optional)_|
| **`remainingMWM`** | `integer` | Editable | Remaining Months of Warranty (MWM) from the manufacturer. _(Optional)_|
| **`financeTerm`** | `integer` | Editable | Length of the loan in months (e.g., **72**). _(Optional)_|
| **`financeType`** | `string` | Editable | The method of acquisition (e.g., `Purchase`, `Lease`). _(Optional)_|
| **`financeApr`** | `decimal` | Editable | The annual percentage rate for the loan (e.g., **6%**). _(Optional)_|
| **`odometer`** | `integer` | Editable | The current mileage/hours on the vehicle (e.g., **321**). _(Required)_|
| **`productType`** | `string` | Editable | A filter for the type of products to return (e.g., `All`). _(Optional)_|
| **`vehiclePrice`** | `decimal` | Editable | The selling price of the vehicle before products or taxes. _(Required)_|
| **`purchaseType`** | `string` | Editable | Indicates if the vehicle is being sold as `New` or `Used`. _(Required)_|
| **`rateDate`** | `date` | Editable | The specific date used to pull the actuarial rate tables. _(Required)_|
| **`vin`** | `string` | Editable | The 17-digit Vehicle Identification Number. _(Required)_|
| **`vtype`** | `string` | Editable | The category of vehicle (e.g., `ATV`, `UTV`). _(Required)_|
| **`vehiclePurchaseDate`** | `date` | Editable | The date the customer officially purchases the vehicle. _(Required)_|
| **`saleDate`** | `date` | Editable | Often identical to purchase date; used for contract start logic. _(Required)_|
| **`inServiceDate`** | `date` | Editable | The date the vehicle first entered service (used for warranty logic). _(Required)_|
| **`year`** | `integer` | Editable | The model year (e.g., **2024**). _(Optional)_|
| **`make`** | `string` | Editable | The manufacturer (e.g., **Polaris**). _(Optional)_|
| **`model`** | `string` | Editable | The specific model name (e.g., **Sportsman 570**). _(Optional)_|
| **`vehicleStatus`** | `string` | Editable | Duplicate of purchaseType; defines the rating tier (New/Used). _(Required)_|
| **`customerCity`** | `string` | Editable | The city of residence for the buyer. _(Optional)_|
| **`customerState`** | `string` | Editable | The 2-letter state code (e.g., **OH**). _(Optional)_|
| **`customerPostalCode`** | `string` | Editable | The 5-digit zip code used for regional tax and rating. _(Optional)_|
| **`displacement`** | `string` | Editable | The engine size in CCs (e.g., **567**). Critical for ATV/UTV rating. _(Optional)_|
| **`fuelType`** | `string` | Editable | The type of fuel used by the vehicle. _(Optional)_|
| **`properties`** | `property[]` | Editable | an array of addtional rating information in the form of name value pairs (e.g., {"name": "msrp", "value": "1278.23"}). _(Optional)_|


> **Notes on the Request Body:**
>
> * **Year, Make, and Model:** These are optional if a valid VIN is provided and the system can successfully decode it. If provided, they will take precedence over the decoded VIN.
> * **Customer Location Fields:** `customerCity`, `customerState`, `customerCountry`, and `customerPostalCode` are all optional. If `customerPostalCode` is not provided, the default will be the dealer's postal code.
> * **Disclaimer:** Failure to provide an accurate Postal Code can result in non-compliance with local governance, and the Shop API does not enforce compliance.

### 6.3\. Vehicle Types
Table of `vtype` values:

| Vehicle Type | Description |
| :--- | :--- |
| **AUTO** | Passenger Car/Truck |
| **MCYC** | On Road Motorcycle |
| **BIKE** | Off Road Motorcycle |
| **ATV** | ATV |
| **SNOW**| Snowmobile |
| **PWAC**| Personal Watercraft |
| **RV** | Motorhome |
| **BOAT**| Boat |
| **TT** | Travel Trailer |
| **UT** | Utility Trailer |
| **UTV** | UTV |
| **SCO** | Scooter |
| **PP** | Personal Policy |
| **HW** | Home Warranty |
| **GC** | Golf Carts |
| **LMW** | Lawn Mower |

### 6.4\. Product Types
Table of `ptype` values:

| Product Type | Description (`label`) |
| :--- | :--- |
| **VSA** | Vehicle Service Agreement |
| **GAP** | GAP Insurance |
| **TAW** | Tire And Wheel |
| **KEY** | Key Replacement |
| **RA** | Roadside Assistance |
| **PAY** | Pay-As-You-Go Service |
| **PPM** | Prepaid Maintenance |
| **PF** | Paint Fab |
| **LW** | Limited Warranty |
| **LP** | Loyalty Program |
| **DIM** | Diminished Value |
| **IDT** | Identity Theft |
| **BAT** | Lifetime Battery |
| **THP** | Theft Protection |
| **OEM** | OEM Aftermarket |
| **CMB** | Combo |
| **WIN** | Windshield |
| **DENT** | Dent |
| **EWT** | Excess Wear/Tear |
| **MS** | Multi-Shield |
| **PPL** | Payment Protection (Loan) |
| **PPC** | Payment Protection (Contract) |
| **DP** | Depreciation Protection |
| **VPP** | Vehicle Protection Plan |

### 6.5\. Fuel Types
Table of `fuelType` values:

| Fuel Type | Description |
| :--- | :--- |
| **G** | Gasoline |
| **E** | Electric |
| **D** | Diesel |

 ## 7\. Contract Submit

This endpoint allows you to submit selected rates and options within a quote to generate contracts. To submit, send the object containing only the products, rates, and options & surcharges you wish to submit. Every product, rate, and option requested will be submitted.

> **Note:** If the postal code used in the Rating step differs from the Buyer's Postal Code used in submission, the administrator will receive the submitted Buyer Postal Code. The Shop API does not enforce these to match.

**Endpoint:** `POST /contract/submit`

**Request Body:**

```json
{
    "lienholder": {
        "lienholderName": "Test",
        "lienholderAddress": "123 Fake Street",
        "lienholderAddress2": "",
        "lienholderCity": "Burr Ridge",
        "lienholderState": "IL",
        "lienholderZip": "60181",
        "lienholderPhone": "8885555555"
    },
    "quote": {
        "ident": 48122,
        "client": 1,
        "webSite": 304,
        "asyncModify": false,
        "rerateFlag": false,
        "referenceNumber": "2026020411",
        "displayName": "MyQuote",
        "createdName": "API Test User",
        "createdWhen": "Feb 4, 2026, 3:49:51 PM",
        "createdIP": "184.57.0.219",
        "modifiedWhen": "Feb 4, 2026, 3:49:54 PM",
        "saleDate": "May 17, 2025, 3:49:54 PM",
        "buyerPostal": "43147",
        "taxRate": 0.0,
        "vehicles": [
            {
                "ident": 48200,
                "quote": 48122,
                "serial": "5YFBURHE6JP837778",
                "asyncModify": false,
                "vehicleType": "AUTO",
                "effectiveDate": "Feb 4, 2026, 3:49:51 PM",
                "odometer": 321,
                "products": [
                    {
                        "ident": 0,
                        "vehicle": 0,
                        "unique": "101",
                        "provider": 6,
                        "selected": false,
                        "customizable": true,
                        "extraInfo": false,
                        "financeable": false,
                        "label": "PPM Program",
                        "desc": "PPM Program",
                        "ptype": "PPM",
                        "rates": [
                            {
                                "ident": 0,
                                "product": 0,
                                "unique": "808-347",
                                "termMiles": -1,
                                "termMonths": 36,
                                "selected": true,
                                "fromService": false,
                                "fromZero": false,
                                "fuzzy": false,
                                "graceDays": 0,
                                "dealerCost": {
                                    "amount": 272.0,
                                    "currency": "USD"
                                },
                                "systemMarkup": {
                                    "percentage": false
                                },
                                "subTotal": {
                                    "amount": 272.0,
                                    "currency": "USD"
                                },
                                "dealerDeduct": {
                                    "amount": -1.0,
                                    "currency": "USD"
                                },
                                "options": [],
                                "expireDate": "Feb 4, 2029, 3:49:51 PM",
                                "expireMiles": 1000321,
                                "consumables": [
                                    {
                                        "label": "Oil Services - LOF",
                                        "quantity": 2
                                    },
                                    {
                                        "label": "27 Point Maintenance Safety Check",
                                        "quantity": 6
                                    },
                                    {
                                        "label": "Tire Rotation",
                                        "quantity": 2
                                    },
                                    {
                                        "label": "$300 Customer Loyalty Coupon for Next Vehicle Purchase ",
                                        "quantity": 1
                                    },
                                    {
                                        "label": "Top Off All Fluids",
                                        "quantity": 6
                                    },
                                    {
                                        "label": "Battery Inspection",
                                        "quantity": 6
                                    },
                                    {
                                        "label": "Brake Inspection",
                                        "quantity": 6
                                    },
                                    {
                                        "label": "Courtesy Shuttle",
                                        "quantity": 6
                                    },
                                    {
                                        "label": "$100 Body Shop",
                                        "quantity": 1
                                    }
                                ],
                                "attributes": {
                                    "from.disappearing": "false",
                                    "reserve.amount": "272.0",
                                    "product.id": "101",
                                    "from.inservice": "false",
                                    "primary.deductible": "-1.0",
                                    "deduct.type": "STD",
                                    "alternate.deductible": "-1.0",
                                    "miles": "-1",
                                    "coverage.limit": "-1.0",
                                    "dealer.cost": "272.0",
                                    "from.zero": "false",
                                    "duration.days": "-1",
                                    "RangeLabel": "*",
                                    "duration.months": "36",
                                    "ProviderRateLabel": "3 Years"
                                }
                            },
                            {
                                "ident": 0,
                                "product": 0,
                                "unique": "810-347",
                                "termMiles": -1,
                                "termMonths": 48,
                                "selected": false,
                                "fromService": false,
                                "fromZero": false,
                                "fuzzy": false,
                                "graceDays": 0,
                                "dealerCost": {
                                    "amount": 384.0,
                                    "currency": "USD"
                                },
                                "systemMarkup": {
                                    "percentage": false
                                },
                                "dealerDeduct": {
                                    "amount": -1.0,
                                    "currency": "USD"
                                },
                                "options": [],
                                "expireDate": "Feb 4, 2030, 3:49:51 PM",
                                "expireMiles": 1000321,
                                "consumables": [
                                    {
                                        "label": "Oil Services - LOF",
                                        "quantity": 4
                                    },
                                    {
                                        "label": "27 Point Maintenance Safety Check",
                                        "quantity": 8
                                    },
                                    {
                                        "label": "Tire Rotation",
                                        "quantity": 4
                                    },
                                    {
                                        "label": "$300 Customer Loyalty Coupon for Next Vehicle Purchase ",
                                        "quantity": 1
                                    },
                                    {
                                        "label": "Top Off All Fluids",
                                        "quantity": 8
                                    },
                                    {
                                        "label": "Battery Inspection",
                                        "quantity": 8
                                    },
                                    {
                                        "label": "Brake Inspection",
                                        "quantity": 8
                                    },
                                    {
                                        "label": "Courtesy Shuttle",
                                        "quantity": 8
                                    },
                                    {
                                        "label": "$100 Body Shop",
                                        "quantity": 1
                                    }
                                ],
                                "attributes": {
                                    "from.disappearing": "false",
                                    "reserve.amount": "384.0",
                                    "product.id": "101",
                                    "from.inservice": "false",
                                    "primary.deductible": "-1.0",
                                    "deduct.type": "STD",
                                    "alternate.deductible": "-1.0",
                                    "miles": "-1",
                                    "coverage.limit": "-1.0",
                                    "dealer.cost": "384.0",
                                    "from.zero": "false",
                                    "duration.days": "-1",
                                    "RangeLabel": "*",
                                    "duration.months": "48",
                                    "ProviderRateLabel": "4 Years"
                                }
                            },
                            {
                                "ident": 0,
                                "product": 0,
                                "unique": "811-347",
                                "termMiles": -1,
                                "termMonths": 60,
                                "selected": false,
                                "fromService": false,
                                "fromZero": false,
                                "fuzzy": false,
                                "graceDays": 0,
                                "dealerCost": {
                                    "amount": 494.0,
                                    "currency": "USD"
                                },
                                "systemMarkup": {
                                    "percentage": false
                                },
                                "dealerDeduct": {
                                    "amount": -1.0,
                                    "currency": "USD"
                                },
                                "options": [],
                                "expireDate": "Feb 4, 2031, 3:49:51 PM",
                                "expireMiles": 1000321,
                                "consumables": [
                                    {
                                        "label": "Oil Services - LOF",
                                        "quantity": 6
                                    },
                                    {
                                        "label": "27 Point Maintenance Safety Check",
                                        "quantity": 10
                                    },
                                    {
                                        "label": "Tire Rotation",
                                        "quantity": 6
                                    },
                                    {
                                        "label": "$300 Customer Loyalty Coupon for Next Vehicle Purchase ",
                                        "quantity": 1
                                    },
                                    {
                                        "label": "Top Off All Fluids",
                                        "quantity": 10
                                    },
                                    {
                                        "label": "Battery Inspection",
                                        "quantity": 10
                                    },
                                    {
                                        "label": "Brake Inspection",
                                        "quantity": 10
                                    },
                                    {
                                        "label": "Courtesy Shuttle",
                                        "quantity": 10
                                    },
                                    {
                                        "label": "$100 Body Shop",
                                        "quantity": 1
                                    }
                                ],
                                "attributes": {
                                    "from.disappearing": "false",
                                    "reserve.amount": "494.0",
                                    "product.id": "101",
                                    "from.inservice": "false",
                                    "primary.deductible": "-1.0",
                                    "deduct.type": "STD",
                                    "alternate.deductible": "-1.0",
                                    "miles": "-1",
                                    "coverage.limit": "-1.0",
                                    "dealer.cost": "494.0",
                                    "from.zero": "false",
                                    "duration.days": "-1",
                                    "RangeLabel": "*",
                                    "duration.months": "60",
                                    "ProviderRateLabel": "5 Years"
                                }
                            }
                        ],
                        "rateClass": "1",
                        "blurb": "\r\n    <p style=\"margin-top: 0\">\r\n      \r\n    </p>\r\n  ",
                        "sortOrder": 0,
                        "siteid": 0,
                        "properties": [],
                        "preview": false,
                        "adminid": 13,
                        "formFields": {
                            "values": []
                        },
                        "providerTaxes": false,
                        "taxRate": 0.0,
                        "attributes": {
                            "ProductTypeLabel": "Loyality & PPM"
                        }
                    },
                    {
                        "ident": 0,
                        "vehicle": 0,
                        "unique": "121",
                        "provider": 6,
                        "selected": false,
                        "customizable": true,
                        "extraInfo": false,
                        "financeable": false,
                        "label": "NAC Extended Service Contract",
                        "desc": "NAC Extended Service Contract",
                        "ptype": "VSA",
                        "rates": [
                            {
                                "ident": 0,
                                "product": 0,
                                "unique": "968-380",
                                "termMiles": 48000,
                                "termMonths": 48,
                                "selected": true,
                                "fromService": false,
                                "fromZero": true,
                                "fuzzy": false,
                                "graceDays": 0,
                                "dealerCost": {
                                    "amount": 919.0,
                                    "currency": "USD"
                                },
                                "systemMarkup": {
                                    "percentage": false
                                },
                                "subTotal": {
                                    "amount": 919.0,
                                    "currency": "USD"
                                },
                                "dealerDeduct": {
                                    "amount": 100.0,
                                    "currency": "USD"
                                },
                                "options": [
                                    {
                                        "ident": 0,
                                        "rateline": 0,
                                        "selected": false,
                                        "mandatory": false,
                                        "desc": "Lift.Kit Modified",
                                        "label": "Lift.Kit Modified",
                                        "unique": "242",
                                        "dealerCost": {
                                            "amount": 225.0,
                                            "currency": "USD"
                                        },
                                        "recurring": false,
                                        "recurPerYear": 0,
                                        "conflict": [],
                                        "attributes": {
                                            "variable": "opt"
                                        }
                                    },
                                    {
                                        "ident": 0,
                                        "rateline": 0,
                                        "selected": false,
                                        "mandatory": false,
                                        "desc": "RideShare / Commerical",
                                        "label": "RideShare / Commerical",
                                        "unique": "240",
                                        "dealerCost": {
                                            "amount": 425.0,
                                            "currency": "USD"
                                        },
                                        "recurring": false,
                                        "recurPerYear": 0,
                                        "conflict": [],
                                        "attributes": {
                                            "variable": "opt-cheddar"
                                        }
                                    }
                                ],
                                "expireDate": "Feb 4, 2030, 3:49:51 PM",
                                "expireMiles": 48000,
                                "consumables": [],
                                "attributes": {
                                    "from.disappearing": "false",
                                    "reserve.amount": "919.0",
                                    "product.id": "121",
                                    "from.inservice": "false",
                                    "primary.deductible": "100.0",
                                    "deduct.type": "STD",
                                    "alternate.deductible": "-1.0",
                                    "miles": "48000",
                                    "coverage.limit": "-1.0",
                                    "dealer.cost": "919.0",
                                    "from.zero": "true",
                                    "duration.days": "-1",
                                    "RangeLabel": "0 - 12,000",
                                    "duration.months": "48",
                                    "ProviderRateLabel": "48/48000 $100.00"
                                }
                            }
                        ],
                        "rateClass": "1",
                        "blurb": "\r\n  ",
                        "sortOrder": 0,
                        "siteid": 0,
                        "properties": [],
                        "preview": false,
                        "adminid": 13,
                        "formFields": {
                            "values": []
                        },
                        "providerTaxes": false,
                        "taxRate": 0.0,
                        "attributes": {
                            "ProductTypeLabel": "Mechanical Breakdow Protection (VSC)"
                        }
                    },
                    {
                        "ident": 0,
                        "vehicle": 0,
                        "unique": "114",
                        "provider": 6,
                        "selected": false,
                        "customizable": true,
                        "extraInfo": false,
                        "financeable": false,
                        "label": "Diminished Value Protection ",
                        "desc": "Diminished Value Protection ",
                        "ptype": "DIM",
                        "rates": [
                            {
                                "ident": 0,
                                "product": 0,
                                "unique": "949-371",
                                "termMiles": -1,
                                "termMonths": 36,
                                "selected": true,
                                "fromService": false,
                                "fromZero": false,
                                "fuzzy": false,
                                "graceDays": 0,
                                "dealerCost": {
                                    "amount": 231.0,
                                    "currency": "USD"
                                },
                                "systemMarkup": {
                                    "percentage": false
                                },
                                "subTotal": {
                                    "amount": 231.0,
                                    "currency": "USD"
                                },
                                "dealerDeduct": {
                                    "amount": -1.0,
                                    "currency": "USD"
                                },
                                "options": [
                                    {
                                        "ident": 0,
                                        "rateline": 0,
                                        "selected": false,
                                        "mandatory": false,
                                        "desc": "Commercial",
                                        "label": "Commercial",
                                        "unique": "391",
                                        "dealerCost": {
                                            "amount": 125.0,
                                            "currency": "USD"
                                        },
                                        "recurring": false,
                                        "recurPerYear": 0,
                                        "conflict": [],
                                        "attributes": {
                                            "variable": "opt.Comm"
                                        }
                                    }
                                ],
                                "expireDate": "Feb 4, 2029, 3:49:51 PM",
                                "expireMiles": 1000321,
                                "consumables": [],
                                "attributes": {
                                    "from.disappearing": "false",
                                    "reserve.amount": "231.0",
                                    "product.id": "114",
                                    "from.inservice": "false",
                                    "primary.deductible": "-1.0",
                                    "deduct.type": "STD",
                                    "alternate.deductible": "-1.0",
                                    "miles": "-1",
                                    "coverage.limit": "-1.0",
                                    "dealer.cost": "231.0",
                                    "from.zero": "false",
                                    "duration.days": "-1",
                                    "RangeLabel": "0 - 10",
                                    "duration.months": "36",
                                    "ProviderRateLabel": "36 Months"
                                }
                            },
                            {
                                "ident": 0,
                                "product": 0,
                                "unique": "950-371",
                                "termMiles": -1,
                                "termMonths": 60,
                                "selected": false,
                                "fromService": false,
                                "fromZero": false,
                                "fuzzy": false,
                                "graceDays": 0,
                                "dealerCost": {
                                    "amount": 275.0,
                                    "currency": "USD"
                                },
                                "systemMarkup": {
                                    "percentage": false
                                },
                                "dealerDeduct": {
                                    "amount": -1.0,
                                    "currency": "USD"
                                },
                                "options": [
                                    {
                                        "ident": 0,
                                        "rateline": 0,
                                        "selected": false,
                                        "mandatory": false,
                                        "desc": "Commercial",
                                        "label": "Commercial",
                                        "unique": "391",
                                        "dealerCost": {
                                            "amount": 125.0,
                                            "currency": "USD"
                                        },
                                        "recurring": false,
                                        "recurPerYear": 0,
                                        "conflict": [],
                                        "attributes": {
                                            "variable": "opt.Comm"
                                        }
                                    }
                                ],
                                "expireDate": "Feb 4, 2031, 3:49:51 PM",
                                "expireMiles": 1000321,
                                "consumables": [],
                                "attributes": {
                                    "from.disappearing": "false",
                                    "reserve.amount": "275.0",
                                    "product.id": "114",
                                    "from.inservice": "false",
                                    "primary.deductible": "-1.0",
                                    "deduct.type": "STD",
                                    "alternate.deductible": "-1.0",
                                    "miles": "-1",
                                    "coverage.limit": "-1.0",
                                    "dealer.cost": "275.0",
                                    "from.zero": "false",
                                    "duration.days": "-1",
                                    "RangeLabel": "0 - 10",
                                    "duration.months": "60",
                                    "ProviderRateLabel": "60 Months"
                                }
                            }
                        ],
                        "rateClass": "1",
                        "blurb": "\r\n    VALUEWISE protects against a financial loss from diminished value due to \r\n    an accident.\r\n  ",
                        "sortOrder": 0,
                        "siteid": 0,
                        "properties": [
                            {
                                "propertyID": 19,
                                "productTypeID": 16,
                                "productType": "Diminished Value Protection",
                                "property": "DV_APR",
                                "label": "Finance APR",
                                "dataType": "STRING",
                                "required": true
                            },
                            {
                                "propertyID": 21,
                                "productTypeID": 16,
                                "productType": "Diminished Value Protection",
                                "property": "DV_Auto_Color",
                                "label": "Vehicle Color",
                                "dataType": "STRING",
                                "required": true
                            },
                            {
                                "propertyID": 20,
                                "productTypeID": 16,
                                "productType": "Diminished Value Protection",
                                "property": "DV_PurchaseType",
                                "label": "Purchase Type",
                                "dataType": "STRING",
                                "required": true,
                                "extension": {
                                    "multiValued": false,
                                    "minimumValue": 0,
                                    "maximumValue": 0,
                                    "minimumOccurs": 0,
                                    "maximumOccurs": 1,
                                    "values": [
                                        {
                                            "key": "-",
                                            "value": "Select"
                                        },
                                        {
                                            "key": "Cash",
                                            "value": "Cash"
                                        },
                                        {
                                            "key": "Lease",
                                            "value": "Lease"
                                        },
                                        {
                                            "key": "Loan",
                                            "value": "Loan"
                                        }
                                    ]
                                }
                            }
                        ],
                        "preview": false,
                        "adminid": 13,
                        "formFields": {
                            "values": []
                        },
                        "providerTaxes": false,
                        "taxRate": 0.0,
                        "attributes": {
                            "ProductTypeLabel": "Diminished Value Protection"
                        }
                    },
                    {
                        "ident": 0,
                        "vehicle": 0,
                        "unique": "97",
                        "provider": 6,
                        "selected": false,
                        "customizable": true,
                        "extraInfo": false,
                        "financeable": false,
                        "label": "Lost Key Protection ",
                        "desc": "Lost Key Protection ",
                        "ptype": "KEY",
                        "rates": [
                            {
                                "ident": 0,
                                "product": 0,
                                "unique": "777-343",
                                "termMiles": -1,
                                "termMonths": 24,
                                "selected": true,
                                "fromService": false,
                                "fromZero": false,
                                "fuzzy": false,
                                "graceDays": 0,
                                "dealerCost": {
                                    "amount": 89.0,
                                    "currency": "USD"
                                },
                                "systemMarkup": {
                                    "percentage": false
                                },
                                "subTotal": {
                                    "amount": 89.0,
                                    "currency": "USD"
                                },
                                "dealerDeduct": {
                                    "amount": -1.0,
                                    "currency": "USD"
                                },
                                "options": [],
                                "expireDate": "Feb 4, 2028, 3:49:51 PM",
                                "expireMiles": 1000321,
                                "consumables": [],
                                "attributes": {
                                    "from.disappearing": "false",
                                    "reserve.amount": "89.0",
                                    "product.id": "97",
                                    "from.inservice": "false",
                                    "primary.deductible": "-1.0",
                                    "deduct.type": "STD",
                                    "alternate.deductible": "-1.0",
                                    "miles": "-1",
                                    "coverage.limit": "-1.0",
                                    "dealer.cost": "89.0",
                                    "from.zero": "false",
                                    "duration.days": "-1",
                                    "RangeLabel": "0 - 15",
                                    "duration.months": "24",
                                    "ProviderRateLabel": "24"
                                }
                            },
                            {
                                "ident": 0,
                                "product": 0,
                                "unique": "778-343",
                                "termMiles": -1,
                                "termMonths": 36,
                                "selected": false,
                                "fromService": false,
                                "fromZero": false,
                                "fuzzy": false,
                                "graceDays": 0,
                                "dealerCost": {
                                    "amount": 102.0,
                                    "currency": "USD"
                                },
                                "systemMarkup": {
                                    "percentage": false
                                },
                                "dealerDeduct": {
                                    "amount": -1.0,
                                    "currency": "USD"
                                },
                                "options": [],
                                "expireDate": "Feb 4, 2029, 3:49:51 PM",
                                "expireMiles": 1000321,
                                "consumables": [],
                                "attributes": {
                                    "from.disappearing": "false",
                                    "reserve.amount": "102.0",
                                    "product.id": "97",
                                    "from.inservice": "false",
                                    "primary.deductible": "-1.0",
                                    "deduct.type": "STD",
                                    "alternate.deductible": "-1.0",
                                    "miles": "-1",
                                    "coverage.limit": "-1.0",
                                    "dealer.cost": "102.0",
                                    "from.zero": "false",
                                    "duration.days": "-1",
                                    "RangeLabel": "0 - 15",
                                    "duration.months": "36",
                                    "ProviderRateLabel": "36"
                                }
                            },
                            {
                                "ident": 0,
                                "product": 0,
                                "unique": "779-343",
                                "termMiles": -1,
                                "termMonths": 48,
                                "selected": false,
                                "fromService": false,
                                "fromZero": false,
                                "fuzzy": false,
                                "graceDays": 0,
                                "dealerCost": {
                                    "amount": 112.0,
                                    "currency": "USD"
                                },
                                "systemMarkup": {
                                    "percentage": false
                                },
                                "dealerDeduct": {
                                    "amount": -1.0,
                                    "currency": "USD"
                                },
                                "options": [],
                                "expireDate": "Feb 4, 2030, 3:49:51 PM",
                                "expireMiles": 1000321,
                                "consumables": [],
                                "attributes": {
                                    "from.disappearing": "false",
                                    "reserve.amount": "112.0",
                                    "product.id": "97",
                                    "from.inservice": "false",
                                    "primary.deductible": "-1.0",
                                    "deduct.type": "STD",
                                    "alternate.deductible": "-1.0",
                                    "miles": "-1",
                                    "coverage.limit": "-1.0",
                                    "dealer.cost": "112.0",
                                    "from.zero": "false",
                                    "duration.days": "-1",
                                    "RangeLabel": "0 - 15",
                                    "duration.months": "48",
                                    "ProviderRateLabel": "48"
                                }
                            },
                            {
                                "ident": 0,
                                "product": 0,
                                "unique": "780-343",
                                "termMiles": -1,
                                "termMonths": 60,
                                "selected": false,
                                "fromService": false,
                                "fromZero": false,
                                "fuzzy": false,
                                "graceDays": 0,
                                "dealerCost": {
                                    "amount": 117.0,
                                    "currency": "USD"
                                },
                                "systemMarkup": {
                                    "percentage": false
                                },
                                "dealerDeduct": {
                                    "amount": -1.0,
                                    "currency": "USD"
                                },
                                "options": [],
                                "expireDate": "Feb 4, 2031, 3:49:51 PM",
                                "expireMiles": 1000321,
                                "consumables": [],
                                "attributes": {
                                    "from.disappearing": "false",
                                    "reserve.amount": "117.0",
                                    "product.id": "97",
                                    "from.inservice": "false",
                                    "primary.deductible": "-1.0",
                                    "deduct.type": "STD",
                                    "alternate.deductible": "-1.0",
                                    "miles": "-1",
                                    "coverage.limit": "-1.0",
                                    "dealer.cost": "117.0",
                                    "from.zero": "false",
                                    "duration.days": "-1",
                                    "RangeLabel": "0 - 15",
                                    "duration.months": "60",
                                    "ProviderRateLabel": "60"
                                }
                            }
                        ],
                        "rateClass": "1",
                        "blurb": "\r\n    Covers programmable key fob for covered vehicle and all other key on \r\n    Member's key ring up to a $400 benefit.\r\n  ",
                        "sortOrder": 0,
                        "siteid": 0,
                        "properties": [],
                        "preview": false,
                        "adminid": 13,
                        "formFields": {
                            "values": []
                        },
                        "providerTaxes": false,
                        "taxRate": 0.0,
                        "attributes": {
                            "ProductTypeLabel": "Lost Key-FOB Protection"
                        }
                    },
                    {
                        "ident": 0,
                        "vehicle": 0,
                        "unique": "82",
                        "provider": 6,
                        "selected": false,
                        "customizable": true,
                        "extraInfo": false,
                        "financeable": false,
                        "label": "Tire & Wheel Protection ",
                        "desc": "Tire & Wheel Protection ",
                        "ptype": "TAW",
                        "rates": [
                            {
                                "ident": 0,
                                "product": 0,
                                "unique": "706-315",
                                "termMiles": -1,
                                "termMonths": 36,
                                "selected": true,
                                "fromService": false,
                                "fromZero": false,
                                "fuzzy": false,
                                "graceDays": 0,
                                "dealerCost": {
                                    "amount": 129.0,
                                    "currency": "USD"
                                },
                                "systemMarkup": {
                                    "percentage": false
                                },
                                "subTotal": {
                                    "amount": 129.0,
                                    "currency": "USD"
                                },
                                "dealerDeduct": {
                                    "amount": -1.0,
                                    "currency": "USD"
                                },
                                "options": [
                                    {
                                        "ident": 0,
                                        "rateline": 0,
                                        "selected": false,
                                        "mandatory": true,
                                        "desc": "Ck",
                                        "label": "Ck",
                                        "unique": "290",
                                        "dealerCost": {
                                            "amount": 0.0,
                                            "currency": "USD"
                                        },
                                        "recurring": false,
                                        "recurPerYear": 0,
                                        "dealerDeduct": {
                                            "amount": -1.0,
                                            "currency": "USD"
                                        },
                                        "otherDeduct": {
                                            "amount": -1.0,
                                            "currency": "USD"
                                        },
                                        "conflict": [],
                                        "attributes": {
                                            "variable": "Sc.Ck"
                                        }
                                    },
                                    {
                                        "ident": 0,
                                        "rateline": 0,
                                        "selected": false,
                                        "mandatory": true,
                                        "desc": "Standard",
                                        "label": "Standard",
                                        "unique": "291",
                                        "dealerCost": {
                                            "amount": 0.0,
                                            "currency": "USD"
                                        },
                                        "recurring": false,
                                        "recurPerYear": 0,
                                        "dealerDeduct": {
                                            "amount": -1.0,
                                            "currency": "USD"
                                        },
                                        "otherDeduct": {
                                            "amount": -1.0,
                                            "currency": "USD"
                                        },
                                        "conflict": [],
                                        "attributes": {
                                            "variable": "Sc.StandardClass"
                                        }
                                    }
                                ],
                                "expireDate": "Feb 4, 2029, 3:49:51 PM",
                                "expireMiles": 1000321,
                                "consumables": [],
                                "attributes": {
                                    "from.disappearing": "false",
                                    "reserve.amount": "129.0",
                                    "product.id": "82",
                                    "from.inservice": "false",
                                    "primary.deductible": "-1.0",
                                    "deduct.type": "STD",
                                    "alternate.deductible": "-1.0",
                                    "miles": "-1",
                                    "coverage.limit": "-1.0",
                                    "dealer.cost": "129.0",
                                    "from.zero": "false",
                                    "duration.days": "-1",
                                    "RangeLabel": "0 - 10",
                                    "duration.months": "36",
                                    "ProviderRateLabel": "3 Years"
                                }
                            },
                            {
                                "ident": 0,
                                "product": 0,
                                "unique": "707-315",
                                "termMiles": -1,
                                "termMonths": 60,
                                "selected": false,
                                "fromService": false,
                                "fromZero": false,
                                "fuzzy": false,
                                "graceDays": 0,
                                "dealerCost": {
                                    "amount": 147.0,
                                    "currency": "USD"
                                },
                                "systemMarkup": {
                                    "percentage": false
                                },
                                "dealerDeduct": {
                                    "amount": -1.0,
                                    "currency": "USD"
                                },
                                "options": [
                                    {
                                        "ident": 0,
                                        "rateline": 0,
                                        "selected": false,
                                        "mandatory": true,
                                        "desc": "Ck",
                                        "label": "Ck",
                                        "unique": "290",
                                        "dealerCost": {
                                            "amount": 0.0,
                                            "currency": "USD"
                                        },
                                        "recurring": false,
                                        "recurPerYear": 0,
                                        "conflict": [],
                                        "attributes": {
                                            "variable": "Sc.Ck"
                                        }
                                    },
                                    {
                                        "ident": 0,
                                        "rateline": 0,
                                        "selected": false,
                                        "mandatory": true,
                                        "desc": "Standard",
                                        "label": "Standard",
                                        "unique": "291",
                                        "dealerCost": {
                                            "amount": 0.0,
                                            "currency": "USD"
                                        },
                                        "recurring": false,
                                        "recurPerYear": 0,
                                        "conflict": [],
                                        "attributes": {
                                            "variable": "Sc.StandardClass"
                                        }
                                    }
                                ],
                                "expireDate": "Feb 4, 2031, 3:49:51 PM",
                                "expireMiles": 1000321,
                                "consumables": [],
                                "attributes": {
                                    "from.disappearing": "false",
                                    "reserve.amount": "147.0",
                                    "product.id": "82",
                                    "from.inservice": "false",
                                    "primary.deductible": "-1.0",
                                    "deduct.type": "STD",
                                    "alternate.deductible": "-1.0",
                                    "miles": "-1",
                                    "coverage.limit": "-1.0",
                                    "dealer.cost": "147.0",
                                    "from.zero": "false",
                                    "duration.days": "-1",
                                    "RangeLabel": "0 - 10",
                                    "duration.months": "60",
                                    "ProviderRateLabel": "5 Years"
                                }
                            }
                        ],
                        "rateClass": "1",
                        "blurb": "\n    <p style=\"margin-top: 0\">\n      \n    </p>\n  ",
                        "sortOrder": 0,
                        "siteid": 0,
                        "properties": [],
                        "preview": false,
                        "adminid": 13,
                        "formFields": {
                            "values": []
                        },
                        "providerTaxes": false,
                        "taxRate": 0.0,
                        "attributes": {
                            "ProductTypeLabel": "Tire & Wheel Protection"
                        }
                    }
                ],
                "form": {
                    "vtype": "AUTO",
                    "controls": [],
                    "postal": {
                        "code": "43147",
                        "city": "Pickerington",
                        "region": "Fairfield",
                        "state": "OH",
                        "country": "US",
                        "latitude": 39.90263,
                        "longitude": -82.752193
                    },
                    "hasPromo": false,
                    "properties": [
                        {
                            "isfromprovider": true,
                            "value": "321",
                            "sortOrder": 0,
                            "isHidden": false,
                            "propertyID": 10,
                            "vehicleTypeID": 5,
                            "vehicleType": "Passenger Car/Truck",
                            "property": "odometer",
                            "label": "Odometer",
                            "dataType": "INTEGER",
                            "required": true
                        },
                        {
                            "isfromprovider": false,
                            "value": "2025-05-17",
                            "sortOrder": 0,
                            "isHidden": false,
                            "propertyID": -1,
                            "vehicleTypeID": -1,
                            "property": "sale.date",
                            "label": "Sale Date",
                            "dataType": "DATE",
                            "required": true
                        },
                        {
                            "isfromprovider": true,
                            "value": "23000",
                            "sortOrder": 0,
                            "isHidden": false,
                            "propertyID": 3,
                            "vehicleTypeID": 5,
                            "vehicleType": "Passenger Car/Truck",
                            "property": "price",
                            "label": "Purchase Price",
                            "dataType": "CURRENCY",
                            "required": true
                        },
                        {
                            "isfromprovider": true,
                            "value": "5YFBURHE6JP837778",
                            "sortOrder": 0,
                            "isHidden": false,
                            "propertyID": -1,
                            "vehicleTypeID": -1,
                            "property": "vin",
                            "label": "VIN",
                            "dataType": "STRING",
                            "required": true
                        },
                        {
                            "isfromprovider": false,
                            "value": "43147",
                            "sortOrder": 0,
                            "isHidden": false,
                            "propertyID": -1,
                            "vehicleTypeID": -1,
                            "property": "postal.code",
                            "label": "Postal Code",
                            "dataType": "STRING",
                            "required": true
                        },
                        {
                            "isfromprovider": true,
                            "value": "",
                            "sortOrder": 0,
                            "isHidden": false,
                            "propertyID": 54,
                            "vehicleTypeID": 5,
                            "vehicleType": "Passenger Car/Truck",
                            "property": "financeMonths",
                            "label": "Finance Term Months(Gap)",
                            "dataType": "INTEGER",
                            "required": true
                        },
                        {
                            "isfromprovider": true,
                            "value": "New",
                            "sortOrder": 0,
                            "isHidden": false,
                            "propertyID": 95,
                            "vehicleTypeID": 5,
                            "vehicleType": "Passenger Car/Truck",
                            "property": "new.used",
                            "label": "New/Used",
                            "dataType": "STRING",
                            "required": true,
                            "extension": {
                                "multiValued": false,
                                "minimumValue": 0,
                                "maximumValue": 0,
                                "minimumOccurs": 1,
                                "maximumOccurs": 1,
                                "values": [
                                    {
                                        "key": "NEW",
                                        "value": "NEW"
                                    },
                                    {
                                        "key": "Status",
                                        "value": ""
                                    },
                                    {
                                        "key": "USED",
                                        "value": "USED"
                                    }
                                ]
                            }
                        }
                    ]
                },
                "attributes": {
                    "fuelName": "Gas",
                    "highPerformance": "false",
                    "year": "2018",
                    "trailerLength": "0",
                    "modelAge": "8",
                    "displacementCL": "1.8",
                    "truckBedLengthCode": "",
                    "plantCity": "TUPELO",
                    "corrosionMiles": "999999",
                    "warrantyDays": "0",
                    "vin": "5YFBURHE6JP837778",
                    "engineVariableTiming": "Yes",
                    "truckBedLength": "",
                    "engineTurboChargerCode": "N",
                    "rearTire": "15R195",
                    "vehicle.isvin": "true",
                    "trailerBodySpec": "",
                    "powertrainWarrantyMonthsTotal": "60",
                    "new.used": "New",
                    "frontAxle": "",
                    "engineVariableTimingCode": "Y",
                    "displacementOUM": "I-L",
                    "marketSegmentation": "Compact Car",
                    "trailerMaterial": "",
                    "finance.type": "Purchase",
                    "engineCarburetion": "Fuel Injection",
                    "batteryKWRatingCode": "",
                    "roadsideMiles": "25000",
                    "fuelNameCode": "G",
                    "engineValvesPerCylinder": "4",
                    "entertainment": "AM/FM CD/MP3",
                    "grossVehicleWeightCode": "",
                    "vinPattern": "5YFBURHE*JP******",
                    "vehicle.purchasedate": "2025-05-17",
                    "frontTireSizeCode": "29",
                    "frontAxleCode": "",
                    "override": "false",
                    "plantISOCountryCode": "USA",
                    "corrosionWarrantyValid": "false",
                    "roadsideWarrantyMilesTotal": "25000",
                    "engineModel": "",
                    "displacementCC": "0",
                    "vehicle.model": "COROLLA L LE XLE SE XSE",
                    "basicWarrantyMonthsTotal": "36",
                    "displacementCI": "110",
                    "basicWarrantyMonthsLeft": "0",
                    "warrantyMonths": "0",
                    "finance.apr": "6.0",
                    "engineTurboCharger": "No",
                    "error.message": "",
                    "rearAxleCode": "",
                    "corrosionMonths": "60",
                    "batteryType": "",
                    "wheels": "4",
                    "corrosionWarrantyOffered": "false",
                    "plantRegion": "MISSISSIPPI",
                    "corrosionWarrantyMilesTotal": "999999",
                    "basicMiles": "36000",
                    "transmission": "ECVT",
                    "transmissionOverdriveCode": "Y",
                    "powertrainWarrantyOffered": "false",
                    "motorcycleUsage": "",
                    "isFuelInjected": "true",
                    "truckTonRating": "",
                    "basicWarrantyValid": "false",
                    "plantCode": "P",
                    "plantRegionCode": "MS",
                    "odometer": "321",
                    "minimumShippingWeight": "2840",
                    "error.class": "",
                    "engineManufacturerCode": "",
                    "vehicle.type.valid": "true",
                    "frontTire": "15R195",
                    "roadsideWarrantyMonthsLeft": "0",
                    "rearAxle": "",
                    "securityType": "Immobilizer and keyless entry",
                    "restraintTypeCode": "7",
                    "frontTirePSI": "0.0",
                    "vin.squish": "5YFBURHEJP",
                    "batteryTypeCode": "",
                    "origin": "Import Built in North America",
                    "truckBrakeType": "",
                    "roadsideWarrantyOffered": "false",
                    "roadsideWarrantyMilesLeft": "24679",
                    "warrantyMiles": "0",
                    "transmissionSpeedCode": "2",
                    "engineHeadConfig": "Double Overhead Camshaft",
                    "engineModelCode": "",
                    "cabConfiguration": "",
                    "rearTireSizeCode": "29",
                    "saleCountry": "",
                    "finance.amount": "23000.0",
                    "roof": "None / Not Available",
                    "corrosionWarrantyMilesLeft": "999999",
                    "batteryVoltage": "0.0",
                    "vehicle.engine.ccs": "110",
                    "incompleteVehicleCode": "N",
                    "powertrainMonths": "60",
                    "engineCylinderCount": "4",
                    "engineSuperChargerCode": "N",
                    "basicWarrantyOffered": "false",
                    "engineCarburetionCode": "F",
                    "engineCarburetionBarrels": "-1",
                    "maximumMSRP": "18600",
                    "maximumTruckTonRating": "0.0",
                    "finance.term": "72",
                    "engineFuelInjectionCode": "M",
                    "trailerMaterialCode": "",
                    "bodyStyleCode": "SD",
                    "engineDutyType": "",
                    "age": "8",
                    "entertainmentCode": "A",
                    "powertrainWarrantyMilesTotal": "60000",
                    "truckTonRatingCode": "",
                    "lastEight": "JP837778",
                    "price": "23000.0",
                    "warranty": "7",
                    "model": "COROLLA L LE XLE SE XSE",
                    "inServiceDate": "2017-07-01",
                    "bodyStyle": "SEDAN",
                    "manufacturerCode": "C175",
                    "engineFuelInjection": "Multiport",
                    "modelYear": "2018",
                    "hasSuperCharger": "false",
                    "basicWarrantyMilesLeft": "35679",
                    "doors": "4",
                    "maximumGrossVehicleWeight": "-1",
                    "minimumTruckTonRating": "0.0",
                    "powertrainMiles": "60000",
                    "vehicle.make": "TOYOTA",
                    "marketSegmentationCode": "F",
                    "vehicle.type.name": "Passenger Car/Truck",
                    "frontTireSize": "15R195",
                    "vehicle.type.id": "5",
                    "manufacturer": "TOYOTA",
                    "roadsideWarrantyMonthsTotal": "24",
                    "cabConfigurationCode": "",
                    "serviceMonths": "103",
                    "hasTurboCharger": "false",
                    "vin.substring": "5YFBURHEJ",
                    "driveType": "Front Wheel Drive",
                    "engineBlockType": "In-Line",
                    "minimumMSRP": "18600",
                    "powertrainWarrantyValid": "false",
                    "manufacturerId": "TOYT",
                    "maximumShippingWeight": "2840",
                    "plantCountry": "United States",
                    "securityTypeCode": "F",
                    "subString": "5YFBURHEJ",
                    "powertrainWarrantyMonthsLeft": "0",
                    "rearTireSize": "15R195",
                    "roadsideMonths": "24",
                    "driveTypeCode": "FWD",
                    "modelBase": "COROLLA",
                    "corrosionWarrantyMonthsLeft": "0",
                    "powertrainWarrantyMilesLeft": "59679",
                    "restraintType": "Du Frnt/Sd/Hd Air Bgs/Rr Hd Ar Bgs/Act Belts",
                    "saleCountryCode": "",
                    "engineHeadConfigCode": "DOHC",
                    "engineDutyTypeCode": "",
                    "engineBlockTypeCode": "I",
                    "engineManufacturer": "",
                    "msrpVariance": "0",
                    "originCode": "B",
                    "roofCode": "1",
                    "engineSuperCharger": "No",
                    "engine.ccs": "110",
                    "serviceDays": "3140",
                    "transmissionCode": "E",
                    "trailerBodySpecCode": "",
                    "sale.date": "2025-05-17",
                    "driveWheels": "2",
                    "minimumGrossVehicleWeight": "-1",
                    "motorcycleUsageCode": "",
                    "truckBrakeTypeCode": "",
                    "absBrakingCode": "All Wheel Std",
                    "rearTirePSI": "0.0",
                    "engineCycleCount": "0",
                    "error": "false",
                    "absBraking": "2",
                    "trailerAxleCount": "0",
                    "minimumWheelBase": "106.3",
                    "maximumWheelBase": "106.3",
                    "postal.code": "43147",
                    "make": "TOYOTA",
                    "roadsideWarrantyValid": "false",
                    "manufacturerParent": "Toyota",
                    "shippingWeightVariance": "0",
                    "basicWarrantyMilesTotal": "36000",
                    "inservice.date": "2025-05-17",
                    "vehicle.year": "2018",
                    "engineValvesTotal": "16",
                    "corrosionWarrantyMonthsTotal": "60",
                    "serial": "5YFBURHE6JP837778",
                    "basicMonths": "36"
                }
            }
        ],
        "lienholder": {
            "ident": 46273,
            "quote": 48122
        },
        "status": 0,
        "calculating": false,
        "attributes": {
            "hashId": "856468b1f1bd92765a0f0062f8e3f4ba"
        }
    }
}
```

### 7.1\. Lienholder Details

The **Lienholder** object contains the legal and contact information for the financial institution or bank that holds the title to the vehicle. This information may be required for the final contract .

| Field | Type | Access | Description |
| --- | --- | --- | --- |
| `lienholderName` | String | Editable | The legal name of the bank or lending institution (e.g., **Test**). |
| `lienholderAddress` | String | Editable | The primary street address for the lender. |
| `lienholderAddress2` | String | Editable | Secondary address info (Suite, Floor, PO Box); currently empty. |
| `lienholderCity` | String | Editable | The city where the lender is located (e.g., **Burr Ridge**). |
| `lienholderState` | String | Editable | The 2-letter state abbreviation (e.g., **IL**). |
| `lienholderZip` | String | Editable | The 5-digit postal code for the lender. |
| `lienholderPhone` | String | Editable | The contact phone number for the lender's financing department. |

---

### 7.2\. Root & Quote Level Fields

These fields manage the session and the high-level quote identity.

| Field | Type | Access | Description |
| --- | --- | --- | --- |
| `sessionId` | String | **Read-Only** | System-generated session token. |
| `dealerCode` | String | **Read-Only** | The dealer's unique ID (fixed per login). |
| `ident` | Integer | **Read-Only** | Database primary key. |
| `referenceNumber` | String | **Read-Only** | The auto-generated tracking number. |
| `displayName` | String | **Read-Only** | Custom name for the quote. |
| `saleDate` | String | **Read-Only** | Date the vehicle is sold/delivered. |
| `taxRate` | Number | **Read-Only** | Applied tax percentage. |

---

###  7.3\. Vehicle Object Fields

Detailed specifications for the Polaris UTV in the JSON.

| Field | Type | Access | Description |
| --- | --- | --- | --- |
| `ident` | Integer | **Read-Only** | Unique vehicle record ID. |
| `serial` (VIN) | String | **Read-Only** | The Vehicle Identification Number. |
| `vehicleType` | String | **Read-Only** | Static category (UTV). |
| `effectiveDate` | String | **Read-Only** | Start date for service contracts. |
| `odometer` | Integer | **Read-Only** | Current mileage or hours. |

---

###  7.4\. Rates

These fields describe the protection products offered to the customer.

| Field | Type | Access | Description |
| --- | --- | --- | --- |
| `unique` | String | **Read-Only** | Unique product/rate identifier. |
| `label` | String | **Read-Only** | Full marketing name of the product. |
| `selected` | Boolean | Editable | Toggle to include/exclude from the quote. |
| `dealerCost` | Object | **Read-Only** | Fixed cost charged by the provider. |
| `subTotal` | Object | **Read-Only** | Calculated total cost before markup. |
| `termMonths` | Integer | **Read-Only** | Length of coverage in months. |
| `systemMarkup.percentage` | Boolean | Editable | Determines if the system-level markup is a percentage calculation (**true**) or a flat fee (**false**). |
| `systemMarkup.adjustment.amount` | Number | Editable | The specific dollar amount added to the cost by the service provider (e.g., **104**). |
| `systemMarkup.adjustment.currency` | String | Editable | The currency code for the provider adjustment (e.g., **USD**). |
| `providerMarkup.adjustment.amount` | Number | Editable | The specific dollar amount added to the cost by the service provider (e.g., **104**). |
| `providerMarkup.adjustment.currency` | String | Editable | The currency code for the provider adjustment (e.g., **USD**). |
| `providerMarkup.percentage` | Boolean | Editable | Determines if the provider's specific adjustment is calculated as a percentage (**true**) or a flat fee (**false**). |
---


### 7.5\. Product Options & Surcharges

Found within the `rates[].options` array. These modify the final contract price based on vehicle equipment or usage.

| Field Path | Type | Access | Description |
| --- | --- | --- | --- |
| `code` | String | **Read-Only** | The unique shorthand identifier for the option (e.g., `HVAC`, `SNOW`). |
| `label` | String | **Read-Only** | The human-readable name displayed in the UI. |
| `desc` | String | **Read-Only** | A longer description of what the surcharge covers. |
| `selected` | Boolean | Editable | Toggle indicating if the user has opted to include this surcharge. |
| `mandatory` | Boolean | **Read-Only** | If **true**, this option must be included. |
| `dealerCost.amount` | Number | **Read-Only** | The price the dealer pays for this specific add-on. |
| `dealerDeduct.amount` | Number | **Read-Only** | A dealer-applied discount specific to this option (e.g., `-1`). |
| `otherDeduct.amount` | Number | **Read-Only** | Third-party or provider-level deductions for this option. |
| `recurring` | Boolean | **Read-Only** | Indicates if this is a repeating charge (Subscription) or one-time fee. |
| `conflict` | Array | **Read-Only** | Lists other options that cannot be selected simultaneously with this one. |

---


### 7.6\. Logic Implementation Note

In the provided JSON, both `percentage` flags are set to `false`. This indicates that the pricing engine is treating the **104** as a flat **$104.00 USD** surcharge rather than a 104% increase.


### 7.7\. Form Properties

These fields define the inputs required to validate the quote. Many include an `extension` object that provides a dropdown list of valid values.

| Field Path | Type | Access | Description |
| --- | --- | --- | --- |
| `property` | String | **Read-Only** | The programmatic key (e.g., `finance.type`, `new.used`). |
| `label` | String | **Read-Only** | The UI label (e.g., "Finance Type", "Car Status"). |
| `value` | Mixed | **Read-Only** | The actual data entered by the user (e.g., "Purchase", "New"). |
| `dataType` | String | **Read-Only** | Validation type: `STRING`, `DECIMAL`, `INTEGER`, or `DATE`. |
| `required` | Boolean | **Read-Only** | If **true**, the quote cannot be finalized without this value. |
| `isfromprovider` | Boolean | **Read-Only** | If **true**, the form property is required by the provider. |
| `extension.values` | Array | **Read-Only** | A list of key-value pairs for dropdown menus (e.g., N=None, F=Loan). |
| `sortOrder` | Integer | **Read-Only** | Determines the sequence of fields on the entry form. |

---

### 7.8\. Quote Attributes

The `attributes` section contains the "flattened" metadata. This is where the system stores specific technical details like engine size or warranty status.

> **Note:** All fields in the attributes object are **Read-Only**

###  7.9\. Buyer & System Status

Information about the customer and the quote lifecycle.

| Field | Type | Access | Description |
| --- | --- | --- | --- |
| `buyerFirstName` | String | Editable | Legal first name of the buyer. |
| `buyerLastName` | String | Editable | Legal last name of the buyer. |
| `buyerAddress` | String | Editable | Customer street address. |
| `lienholder.ident` | Integer | **Read-Only** | Identifier used to track lienholders. |
| `status` | Integer | **Read-Only** | System state (e.g., 0 for Draft). |
| `calculating` | Boolean | **Read-Only** | Flag indicating if the pricing engine is running. |


**Successful Response:**

Upon success, you will receive a list of **`contractNumbers`**, **`pdfLinks`**, and **`rateUniqueIds`** pertaining to each product and rate submitted.

```json
{
    "contracts": [
        {
            "contractNumber": "2870",
            "productId": 28753,
            "rateUniqueId": "808-347",
            "pdfLink": "https://tecassured-API.ratessys-qa.com/final/4630B3DAFB0EE5821B1599FEC0723E2F"
        }
    ]
}
```

**Error Response:**

If this request fails, the returned JSON will include an **`error`** field with a short description of the issue.

-----

## 8\. Contract Document Retrieval

This endpoint allows you to retrieve a contract document in Base64 encoded PDF format, along with a direct download link and signature coordinates if any are present.

**Endpoint:** `POST /contract/document`

**Request Body:**

```json
{
    "sessionId": "097e6b71-f59a-4c14-9879-903118388fd7",
    "dealerCode": "3-296",
    "productId": 36053,
    "contractNumber": "VPSR8082312-3037"
}
```

**Response Body:**

```json
{
    "error": "",
    "data": "Base64 Data Here",
    "pdfLink": "https://ratessys-qa.com/final/8A2DC4A71A868429C83604E080223052",
     "signature": {
        "top": 124.85156250000009,
        "left": 234.3046875,
        "bottom": 112.8515625,
        "right": 299.1328125,
        "type": "buyer",
        "page": 1
    }
}
```

## 9\. Contract Voiding

This endpoint allows you to void a contract that was previously submitted through our system.

**Endpoint:** `POST /contract/void`

**Request Body:**

```json
{
    "sessionId": "097e6b71-f59a-4c14-9879-903118388fd7",
    "dealerCode": "3-296",
    "productId": 36053,
    "contractNumber": "VPSR8082312-3037"
}
```

**Response Body:**

```json
{
    "error": "",
    "message": "Contract Successfully Voided."
}
```

## 10\. Makes

This endpoint retrieves a list of all makes and their corresponding vehicle types (`vtypes`) supported by a specific dealer. 

> **Note:** This feature is only available if the dealer code supports this function; otherwise, no results will be returned.

**Endpoint:** `POST /ps/makes`

**Request Body:**

```json
{
    "sessionId":"{{sessionID}}",
    "dealerCode": "3-245" 
}
```

**Response Body:**

```json
{
    "vehicles": [
        {
            "make": "Arctic Cat",
            "vtype": "ATV"
        },
        {
            "make": "Can-Am",
            "vtype": "ATV"
        },
        {
            "make": "CFMOTO",
            "vtype": "ATV"
        },
        {
            "make": "ETON",
            "vtype": "ATV"
        },
        {
            "make": "Hisun",
            "vtype": "ATV"
        },
        {
            "make": "Honda",
            "vtype": "ATV"
        },
        {
            "make": "Kawasaki",
            "vtype": "ATV"
        },
        {
            "make": "KAYO",
            "vtype": "ATV"
        },
        {
            "make": "KYMCO USA INC",
            "vtype": "ATV"
        },
        {
            "make": "MASSIMO",
            "vtype": "ATV"
        },
        {
            "make": "Polaris",
            "vtype": "ATV"
        },
        {
            "make": "Suzuki",
            "vtype": "ATV"
        },
        {
            "make": "Textron Off Road",
            "vtype": "ATV"
        },
        {
            "make": "Yamaha",
            "vtype": "ATV"
        },
        {
            "make": "Captain's",
            "vtype": "BOAT"
        },
        {
            "make": "Cruiser",
            "vtype": "BOAT"
        },
        {
            "make": "Dayboat",
            "vtype": "BOAT"
        },
        {
            "make": "Marine",
            "vtype": "BOAT"
        },
        {
            "make": "Marlin",
            "vtype": "BOAT"
        },
        {
            "make": "Offshore Sportsman's",
            "vtype": "BOAT"
        },
        {
            "make": "Pontoon",
            "vtype": "BOAT"
        },
        {
            "make": "Runabout",
            "vtype": "BOAT"
        },
        {
            "make": "SeaDoo",
            "vtype": "BOAT"
        },
        {
            "make": "Ski",
            "vtype": "BOAT"
        },
        {
            "make": "Sportsman's",
            "vtype": "BOAT"
        },
        {
            "make": "Yacht",
            "vtype": "BOAT"
        },
        {
            "make": "Golf Cart",
            "vtype": "GC"
        },
        {
            "make": "COMMERCIAL MOWER",
            "vtype": "LMW"
        },
        {
            "make": "RESIDENTIAL MOWER",
            "vtype": "LMW"
        },
        {
            "make": "Powersport Trailer",
            "vtype": "Powersport Trailer"
        },
        {
            "make": "Honda",
            "vtype": "PWC"
        },
        {
            "make": "Kawasaki",
            "vtype": "PWC"
        },
        {
            "make": "Sea Doo",
            "vtype": "PWC"
        },
        {
            "make": "Yamaha",
            "vtype": "PWC"
        },
        {
            "make": "5th Wheel",
            "vtype": "RV"
        },
        {
            "make": "MotorHome",
            "vtype": "RV"
        },
        {
            "make": "Pop-Up",
            "vtype": "RV"
        },
        {
            "make": "Slide-in Camper",
            "vtype": "RV"
        },
        {
            "make": "Travel Trailer",
            "vtype": "RV"
        },
        {
            "make": "Arctic Cat",
            "vtype": "Snowmobile"
        },
        {
            "make": "Kawasaki",
            "vtype": "Snowmobile"
        },
        {
            "make": "Lynx",
            "vtype": "Snowmobile"
        },
        {
            "make": "Polaris",
            "vtype": "Snowmobile"
        },
        {
            "make": "Ski-Doo",
            "vtype": "Snowmobile"
        },
        {
            "make": "Widescape",
            "vtype": "Snowmobile"
        },
        {
            "make": "Yamaha",
            "vtype": "Snowmobile"
        },
        {
            "make": "American Landmaster",
            "vtype": "UTV"
        },
        {
            "make": "Arctic Cat",
            "vtype": "UTV"
        },
        {
            "make": "Bennche",
            "vtype": "UTV"
        },
        {
            "make": "Bobcat",
            "vtype": "UTV"
        },
        {
            "make": "Can-Am",
            "vtype": "UTV"
        },
        {
            "make": "CFMOTO",
            "vtype": "UTV"
        },
        {
            "make": "Cub Cadet",
            "vtype": "UTV"
        },
        {
            "make": "GRAVELY",
            "vtype": "UTV"
        },
        {
            "make": "HAMMERHEAD",
            "vtype": "UTV"
        },
        {
            "make": "Hisun",
            "vtype": "UTV"
        },
        {
            "make": "Honda",
            "vtype": "UTV"
        },
        {
            "make": "Husqvarna",
            "vtype": "UTV"
        },
        {
            "make": "Intimidator",
            "vtype": "UTV"
        },
        {
            "make": "John Deere",
            "vtype": "UTV"
        },
        {
            "make": "Kawasaki",
            "vtype": "UTV"
        },
        {
            "make": "KYMCO USA INC",
            "vtype": "UTV"
        },
        {
            "make": "Mahindra",
            "vtype": "UTV"
        },
        {
            "make": "MASSIMO",
            "vtype": "UTV"
        },
        {
            "make": "Odes",
            "vtype": "UTV"
        },
        {
            "make": "Polaris",
            "vtype": "UTV"
        },
        {
            "make": "Segway",
            "vtype": "UTV"
        },
        {
            "make": "SSR Motorsports",
            "vtype": "UTV"
        },
        {
            "make": "Suzuki",
            "vtype": "UTV"
        },
        {
            "make": "Textron Off Road",
            "vtype": "UTV"
        },
        {
            "make": "TRAILMASTER",
            "vtype": "UTV"
        },
        {
            "make": "Yamaha",
            "vtype": "UTV"
        },
        {
            "make": "Speed UTV",
            "vtype": "UTV"
        },
        {
            "make": "REWACO USA",
            "vtype": "Motorcycle"
        }
    ]
}
```

## 11\. Models

This endpoint retrieves a list of all models for a given make and their corresponding vehicle types (`vtypes`).

> **Note:** This feature is only available if the dealer code supports this function; otherwise, no results will be returned.

**Endpoint:** `POST /ps/models`

**Request Body:**

```json
{
    "sessionId":"{{sessionID}}",
    "dealerCode": "3-245",
    "make": "Can-Am"
}
```

**Response Body:**

```json
{
    "vehicles": [
        {
            "make": "Can-Am",
            "model": "ATV",
            "vtype": "ATV"
        },
        {
            "make": "Can-Am",
            "model": "Youth ATV",
            "vtype": "ATV"
        },
        {
            "make": "Can-Am",
            "model": "Mudsport",
            "vtype": "UTV"
        },
        {
            "make": "Can-Am",
            "model": "Maverick R",
            "vtype": "UTV"
        },
        {
            "make": "Can-Am",
            "model": "Sport UTV",
            "vtype": "UTV"
        },
        {
            "make": "Can-Am",
            "model": "UTV",
            "vtype": "UTV"
        },
        {
            "make": "Can-Am",
            "model": "Youth UTV",
            "vtype": "UTV"
        }
    ]
}
```