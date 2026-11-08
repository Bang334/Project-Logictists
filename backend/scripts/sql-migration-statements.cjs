// Split repository-generated DDL, preserving PostgreSQL dollar-quoted function
// bodies. Not intended for arbitrary customer-provided SQL.
function migrationStatements(sql) {
  const bodies = [];
  const protectedSql = sql.replace(/(\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$)[\s\S]*?\1/g, body => {
    bodies.push(body); return `__TMS_DOLLAR_BODY_${bodies.length - 1}__`;
  });
  return protectedSql.split(/;\s*(?:\r?\n|$)/).map(statement => statement.trim())
    .filter(statement => statement.replace(/--[^\n]*/g, '').trim())
    .map(statement => statement.replace(/__TMS_DOLLAR_BODY_(\d+)__/g, (_, index) => bodies[Number(index)]));
}
function transactionalDdl(sql) {
  return 'DO $tms_migration$ BEGIN\n' + migrationStatements(sql).map((statement, index) => {
    const delimiter = `$tms_statement_${index}$`;
    if (statement.includes(delimiter)) throw new Error('DDL delimiter collision');
    return `EXECUTE ${delimiter}${statement}${delimiter};`;
  }).join('\n') + '\nEND $tms_migration$;';
}
module.exports = { migrationStatements, transactionalDdl };
