// npm run migrate: apply pending migrations and exit.
import {connect} from './index.js';
import {migrate} from './migrate.js';

const sql = connect(undefined, 1);
migrate(sql).
    then((n) => {
        console.log(n ? `Applied ${n} migration(s).` : 'Database is up to date.');
        return sql.end();
    }).
    catch(async (e) => {
        console.error(e);
        await sql.end();
        process.exit(1);
    });
