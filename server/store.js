import { MongoClient } from 'mongodb';

export class MongoStore {
  constructor(uri) {
    this.client = new MongoClient(uri, { maxPoolSize: 5, serverSelectionTimeoutMS: 8000 });
  }
  async connect() {
    await this.client.connect();
    this.db = this.client.db('relay');
    await Promise.all([
      this.db.collection('history').createIndex({ receivedAt: 1 }, { expireAfterSeconds: 172800 }),
      this.db.collection('history').createIndex({ deviceId: 1, receivedAt: -1 }),
    ]);
  }
  async ingest(snapshot) {
    const receivedAt = new Date();
    const { processes, ...metrics } = snapshot;
    await Promise.all([
      this.db.collection('devices').replaceOne({ _id: snapshot.deviceId }, { _id: snapshot.deviceId, ...snapshot, receivedAt }, { upsert: true }),
      this.db.collection('history').insertOne({ ...metrics, receivedAt }),
    ]);
  }
  async devices() { return this.db.collection('devices').find({}).toArray(); }
  async history(deviceId) {
    return this.db.collection('history').find({ deviceId, receivedAt: { $gte: new Date(Date.now() - 3600000) } },
      { projection: { _id: 0, receivedAt: 1, cpuPercent: 1, memoryUsedBytes: 1, memoryTotalBytes: 1, battery: 1 } })
      .sort({ receivedAt: -1 }).limit(120).toArray().then(rows => rows.reverse());
  }
  async close() { await this.client.close(); }
}
