import fs from 'fs';
import minifier from 'html-minifier'

import { configuration, GAP_LIMIT, EXTERNAL_EXPLORER_URL, NETWORKS } from '../settings';
import { reportTemplate } from '../templates/report.html'
import { toUnprefixedCashAddress } from "../helpers";

// @ts-ignore
import sb from 'satoshi-bitcoin';

function toBaseUnit(amount: number) {
    // to bitcoins (or equivalent unit)
    let n = sb.toSatoshi(amount);

    // if is float, truncate (no float expected)
    // (this kind of issue can happen with imported operations
    //  and does not affect the comparison itself)
    if (n % 1 !== 0) {
        n = Math.trunc(n);
    }

    return String(n);
}

// align float numbers or zeros
function renderAmount(amount: number) {
    const decimalPrecision = 8;
    const filler = '¤'; // (any non-numeric non-dot char)
    let n;

    // non-strict equality required here
    // tslint:disable-next-line
    if (amount == 0) {
        // align '0': insert filler on the right
        n = '0'.padEnd(decimalPrecision + 2, filler);
    }
    else {
        n = sb.toBitcoin(amount).toFixed(decimalPrecision);
    }

    // align any number: insert filler on the left
    n = String(n).padStart(decimalPrecision * 2, filler);

    // insert non-breaking spaces by replacing the filler with `&nbsp;`
    return '<span class="monospaced">' + n.split(filler).join('&nbsp;') + '</span>';
}

// mapping between the currency and the default external explorer
// expected coin name
function getCoinName() {
    return configuration.currency.toLowerCase().replace(' ', '-');
}

// make address clickable
function addressAsLink(address: string) {
    // if no address, return empty string
    // (used for CSV files that do not contain any address)
    if (typeof(address) === 'undefined') {
        return '';
    }

    const url = EXTERNAL_EXPLORER_URL
        .replace('{coin}', getCoinName())
        .replace('{type}', 'address')
        .replace('{item}', address);
    
    address = address.length < 45 ? address : address.substring(0, 45) + '...';

    return '<a class="monospaced" href="' + url + '" target=_blank>' + address + "</a>"
}

function renderAddress(address: string, cashAddress?: string) {
    let renderedAddress = addressAsLink(address);

    if (configuration.symbol !== 'BCH' || !cashAddress) {
        return renderedAddress;
    } else {
        // Bitcoin Cash: handle Legacy/Cash address duality:
        //  {legacy}
        //  {Cash address}
        return renderedAddress.concat('</br>').concat(addressAsLink(cashAddress));
    }
}

// make TXID clickable
function renderTxid(txid: string) {
    const url = EXTERNAL_EXPLORER_URL
        .replace('{coin}', getCoinName())
        .replace('{type}', 'transaction')
        .replace('{item}', txid);
        
    txid = txid.substring(0, 10) + '...';

    return '<a class="monospaced" href="' + url + '" target=_blank>' + txid + "</a>"
}

// explain some operation types
function createTooltip(opType: string) {
    if (opType === 'Sent' || opType === 'Received') {
        return opType;
    }

    let tooltip: string = '';

    if (opType === 'Received (non-sibling to change)') {
        tooltip = `
        <span class="tooltiptext">
            Change address that received funds from an address NOT belonging to the same xpub
        </span>
        `
    }
    else if (opType === 'Sent to self') {
        tooltip = `
        <span class="tooltiptext">
            Sent to itself (same address)
        </span>
        ` 
    }
    else if (opType === 'Sent to sibling') {
        tooltip = `
        <span class="tooltiptext">
            Sent to another address, belonging to the same xpub (sibling)
        </span>
        ` 
    }

    return '<div class="tooltip">' + opType + tooltip + '</div>'
}

function saveHTML(object: any, directory: string) {
    let report = reportTemplate;

    // meta
    for (const key of Object.keys(object.meta)) {
        report = report.split('{' + key + '}').join(object.meta[key]);
    }

    // summary
    const summary: string[] = [];
    for (const e of object.summary) {
        summary.push('<tr><td>' + e.addressType + '</td>');

        const balance = sb.toBitcoin(e.balance);

        // non-strict equality required here
        if (balance === 0) {
            summary.push('<td class="summary_empty">');
        }
        else {
            summary.push('<td class="summary_non_empty">');
        }

        summary.push(balance + '</td></tr>');
    }

    report = report.replace('{summary}', summary.join(''));
    
    // addresses
    const addresses: string[] = [];
    
    for (const e of object.addresses) {
        addresses.push('<tr><td>' + e.addressType + '</td>');

        const derivationPath = 'm/' + e.derivation.account + '/' + e.derivation.index;
        addresses.push('<td>' + derivationPath + '</td>')

        addresses.push('<td>' + renderAddress(e.address, e.cashAddress) + '</td>')

        const balance = renderAmount(e.balance);
        const funded = renderAmount(e.funded);
        const spent = renderAmount(e.spent);

        addresses.push('<td>' + balance + '</td>');
        addresses.push('<td>' + funded + '</td>');
        addresses.push('<td>' + spent + '</td></tr>');
    }

    report = report.replace('{addresses}', addresses.join(''));

    // transactions

    // display warning if default provider is being used
    if (object.meta.provider === 'default') {
        report = report.replace('{warning}', 'Default provider used: only the last ~50 operations by address are displayed');
    }
    else {
        report = report.replace('{warning}', '');
    }

    const transactions: string[] = [];
    for (const e of object.transactions) {
        transactions.push('<tr><td>' + e.date + '</td>');
        transactions.push('<td>' + e.block + '</td>');
        transactions.push('<td>' + renderTxid(e.txid) + '</td>');
        transactions.push('<td>' + renderAddress(e.address, e.cashAddress) + '</td>');
        transactions.push('<td>' + renderAmount(e.amount) + '</td>');
        transactions.push('<td>' + createTooltip(e.operationType) + '</td></tr>');
    }
    
    report = report.replace('{transactions}', transactions.join(''));

    // comparisons
    const comparisonsTemplate = `
        <li class="tab">
        <input type="radio" name="tabs" id="tab4" />
        <label for="tab4">Comparisons</label>
        <div id="tab-content4" class="content">
        <table>
            <thead>
                <tr style="text-align: center">
                    <th rowspan="1" colspan="3">Imported</th>
                    <th rowspan="1" colspan="3">Actual</th>
                    <th rowspan="2" colspan="1">TXID</th>
                    <th rowspan="2" colspan="1">Type</th>
                    <th rowspan="2" colspan="1">Status</th>
                </tr>
                <tr>
                    <th>Date</th>
                    <th>Address</th>
                    <th>Amount</th>
                    <th>Date</th>
                    <th>Address</th>
                    <th>Amount</th>
                </tr>
            </thead>
            <tbody>
                {comparisons}
            </tbody>
        </table>
        </div>
        </li>
        `

    const comparisons: string[] = [];
    if (typeof(object.comparisons) !== 'undefined') {
        for (const e of object.comparisons) {

            let txid: string = '';
            let opType: string = '';

            // by default: no imported operation
            const imported = { date: '', address: '(no operation)', amount: '' };

            if (typeof(e.imported) !== 'undefined') {
                imported.date = e.imported.date;
                imported.address = renderAddress(e.imported.address);
                imported.amount = renderAmount(e.imported.amount);
                txid = e.imported.txid;
                opType = e.imported.operationType;
            }

            // by default: no actual operation
            const actual = { date: '', address: '(no operation)', amount: '' };

            if (typeof(e.actual) !== 'undefined') {
                actual.date = e.actual.date;
                actual.address = renderAddress(e.actual.address, e.actual.cashAddress);
                actual.amount = renderAmount(e.actual.amount);
                txid = e.actual.txid;
                opType = e.actual.operationType;
            }

            if (e.status === 'Match') {
                comparisons.push('<tr class="comparison_match">')
            }
            else {
                comparisons.push('<tr class="comparison_mismatch">')
            }

            comparisons.push('<td>' + imported.date + '</td>');
            comparisons.push('<td>' + imported.address + '</td>');
            comparisons.push('<td>' + imported.amount + '</td>');
            comparisons.push('<td>' + actual.date + '</td>');
            comparisons.push('<td>' + actual.address + '</td>');
            comparisons.push('<td>' + actual.amount + '</td>');
            comparisons.push('<td>' + renderTxid(txid) + '</td>');
            comparisons.push('<td>' + createTooltip(opType) + '</td>');
            comparisons.push('<td>' + e.status + '</td></tr>');
        }
    }

    const comparisonTable = comparisonsTemplate.replace('{comparisons}', comparisons.join(''));

    if (comparisons.length === 0) {
        report = report.replace('{comparisons}', '');
    }
    else {
        report = report.replace('{comparisons}', comparisonTable);
    }

    const filepath = 
        directory
            .concat('/')
            .concat(object.meta.xpub)
            .concat('.html')

    const minifiedReport = minifier.minify(report, {
        removeAttributeQuotes: true,
        minifyCSS: true,
        removeComments: true,
    });

    fs.writeFile(filepath, minifiedReport, function(err) {
        if (err) {
            console.log(err);
        }
    });

    console.log('HTML report saved: '.concat(filepath));
}

function saveJSON(object: any, directory: string) {

    const JSONobject = JSON.stringify(object, null, 2);

    const filepath = 
        directory
        .concat('/')
        .concat(object.meta.xpub)
        .concat('.json')

    if (directory.toLocaleLowerCase() === 'stdout') {
        // display
        console.log(JSONobject);
    }
    else {
        // save file
        fs.writeFile(filepath, JSONobject, function(err) {
            if (err) {
                console.log(err);
            }
        });
    
        console.log('\nJSON export saved: '.concat(filepath));
    }
}

function save(meta: any, data: any, directory: string) {

    // convert amounts into base unit
    const addresses: any[] = data.addresses.map((e: any) => {
        return { 
            addressType: e.addressType,
            derivation: e.getDerivation(),
            address: e.toString(),
            cashAddress: e.asCashAddress(),
            balance: toBaseUnit(e.balance),
            funded: toBaseUnit(e.stats.funded),
            spent: toBaseUnit(e.stats.spent)
        };
    });

    const summary: any[] = data.summary.map((e: any) => {
        return {
            ...e,
            balance: toBaseUnit(e.balance)
        };
    })

    const transactions: any[] = data.transactions.map((e: any) => {
        return {
            ...e,
            cashAddress: toUnprefixedCashAddress(e.address),
            amount: toBaseUnit(e.amount)
        };
    })

    const comparisons: any[] = typeof(data.comparisons) !== 'undefined' ? data.comparisons.map((e: any) => {
        return {
            ...e,
            imported: typeof(e.imported) !== 'undefined' ? {
                ...e.imported,
                amount: toBaseUnit(e.imported.amount)
            } : undefined,
            actual: typeof(e.actual) !== 'undefined' ? {
                ...e.actual,
                cashAddress: toUnprefixedCashAddress(e.actual.address),
                amount: toBaseUnit(e.actual.amount)
            } : undefined
        };
    }) : undefined;

    let providerURL;
    if (typeof(configuration.customAPI) !== 'undefined') {
        providerURL = configuration.customAPI;
    }
    else if (configuration.symbol === 'BCH') {
        providerURL = configuration.defaultAPI.bch;
    }
    else {
        providerURL = configuration.defaultAPI.general;
    }

    const object = {
        meta: {
            by: "xpub scan <https://github.com/LedgerHQ/xpub-scan>",
            version: meta.version,
            xpub: meta.xpub,
            analysis_date: meta.date,
            currency: configuration.currency,
            provider: configuration.providerType,
            provider_url: providerURL,
            gap_limit: GAP_LIMIT,
            unit: "Base unit (i.e., satoshis or equivalent unit)"
        },
        addresses,
        summary,
        transactions,
        comparisons
    } 

    // if no filepath/filename specify -> set to current directory
    if (directory === '') {
        directory = __dirname;
    }

    saveJSON(object, directory);

    if (directory.toLocaleLowerCase() !== 'stdout') {
        saveHTML(object, directory);
    }
}

export { save }
