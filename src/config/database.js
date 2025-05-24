import pg from "pg";

export const pgClient = new pg.Pool({
  user: process.env.dbuser,
  host: process.env.dbhost,
  database: process.env.dbdatabase,
  password: process.env.dbpassword,
  port: process.env.dbport,
});