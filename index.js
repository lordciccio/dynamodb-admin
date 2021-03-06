const express = require('express')
const AWS = require('aws-sdk')
const promisify = require('es6-promisify')
const path = require('path')
const errorhandler = require('errorhandler')
const { extractKey, parseKey } = require('./util')
const bodyParser = require('body-parser')
const pickBy = require('lodash/pickBy')
const omit = require('lodash/omit')
const yaml = require('js-yaml')
const querystring = require('querystring');

require('es7-object-polyfill')

if (process.env.NODE_ENV === 'production') {
  console.error('\x1b[31mDo not run this in production!') // red
  process.exit(1)
}

const app = express()
app.set('json spaces', 2)
app.set('view engine', 'ejs')
app.set('views', path.resolve(__dirname, 'views'))

AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'key',
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'secret',
  endpoint: process.env.DYNAMO_ENDPOINT || 'http://localhost:8000',
  sslEnabled: process.env.DYNAMO_ENDPOINT && process.env.DYNAMO_ENDPOINT.indexOf('https://') === 0,
  region: process.env.AWS_REGION || 'us-east-1'
})

const dynamodb = new AWS.DynamoDB()
const docClient = new AWS.DynamoDB.DocumentClient()

const listTables = promisify(dynamodb.listTables.bind(dynamodb))
const describeTable = promisify(dynamodb.describeTable.bind(dynamodb))
const getItem = promisify(docClient.get.bind(docClient))
const putItem = promisify(docClient.put.bind(docClient))
const deleteItem = promisify(docClient.delete.bind(docClient))

app.use(errorhandler())
app.use('/assets', express.static(path.join(__dirname, '/public')))

app.get('/', (req, res) => {
  dynamodb.listTables({}, (error, data) => {
    if (error) {
      res.json({error})
    } else {
      Promise.all(data.TableNames.map((TableName) => {
        return describeTable({TableName}).then((data) => data.Table)
      })).then((data) => {
        res.render('tables', {data})
      }).catch((error) => {
        res.json({error})
      })
    }
  })
})

app.get('/create-table', (req, res) => {
  res.render('create-table', {})
})

app.post('/create-table', bodyParser.urlencoded({extended: false}), (req, res, next) => {
  dynamodb.createTable({
    TableName: req.body.TableName,
    ProvisionedThroughput: {
      ReadCapacityUnits: req.body.ReadCapacityUnits,
      WriteCapacityUnits: req.body.WriteCapacityUnits
    },
    KeySchema: [{
      AttributeName: 'id',
      KeyType: 'HASH'
    }],
    AttributeDefinitions: [{
      AttributeName: 'id',
      AttributeType: 'S'
    }]
  }).promise().then((response) => {
    res.redirect('/')
  }).catch(next)
})

app.delete('/tables/:TableName', (req, res, next) => {
  const TableName = req.params.TableName
  dynamodb.deleteTable({TableName}).promise()
  .then(() => {
    res.status(204).end()
  })
  .catch(next)
})

app.get('/tables/:TableName/get', (req, res, next) => {
  const TableName = req.params.TableName
  if (req.query.hash) {
    if (req.query.range) {
      return res.redirect(`/tables/${TableName}/items/${req.query.hash}${encodeURIComponent(',')}${req.query.range}`)
    } else {
      return res.redirect(`/tables/${TableName}/items/${req.query.hash}`)
    }
  }
  describeTable({TableName}).then((description) => {
    const hashKey = description.Table.KeySchema.find((schema) => {
      return schema.KeyType === 'HASH'
    })
    if (hashKey) {
      hashKey.AttributeType = description.Table.AttributeDefinitions.find((definition) => {
        return definition.AttributeName === hashKey.AttributeName
      }).AttributeType
    }
    const rangeKey = description.Table.KeySchema.find((schema) => {
      return schema.KeyType === 'RANGE'
    })
    if (rangeKey) {
      rangeKey.AttributeType = description.Table.AttributeDefinitions.find((definition) => {
        return definition.AttributeName === rangeKey.AttributeName
      }).AttributeType
    }
    res.render('get', Object.assign({},
      description, {
        hashKey,
        rangeKey
      }
    ))
  })
})

app.get('/tables/:TableName', (req, res, next) => {
  const TableName = req.params.TableName
  req.query = pickBy(req.query)
  const filters = omit(req.query, ['_hash', 'range', 'startKey', 'pageNum'])

  describeTable({TableName}).then((description) => {
    let ExclusiveStartKey = req.query.startKey ? JSON.parse(req.query.startKey) : {}
    let pageNum = req.query.pageNum ? parseInt(req.query.pageNum) : 1;
    const ExpressionAttributeNames = {}
    const ExpressionAttributeValues = {}
    const KeyConditionExpression = []
    const FilterExpressions = []

    for (let key in filters) {
      const attributeDefinition = description.Table.AttributeDefinitions.find((definition) => {
        return definition.AttributeName === key
      })
      if (attributeDefinition && attributeDefinition.AttributeType === 'N') {
        req.query[key] = Number(req.query[key])
      }
      ExpressionAttributeNames[`#${key}`] = key
      ExpressionAttributeValues[`:${key}`] = req.query[key]
      const isSchemaKey = description.Table.KeySchema.find((definition) => {
        return definition.AttributeName === key
      });

      FilterExpressions.push(`#${key} = :${key}`)
    }


    const params = pickBy({
      TableName,
      FilterExpression: FilterExpressions.length ? FilterExpressions.join(' AND ') : undefined,
      ExpressionAttributeNames: Object.keys(ExpressionAttributeNames).length ? ExpressionAttributeNames : undefined,
      ExpressionAttributeValues: Object.keys(ExpressionAttributeValues).length ? ExpressionAttributeValues : undefined,
      ExclusiveStartKey: Object.keys(ExclusiveStartKey).length ? ExclusiveStartKey : undefined,
      Limit: 25
    })

    return Promise.all([
      docClient.scan(params).promise()
    ]).then(([result]) => {
      let nextKey = result.LastEvaluatedKey ? encodeURIComponent(JSON.stringify(result.LastEvaluatedKey)) : null;
      const data = Object.assign({}, description, {
        query: req.query,
        yaml,
        omit,
        filters,
        pageNum: pageNum,
        nextKey: nextKey,
        filterQueryString: querystring.stringify(filters),
        Items: result.Items.map((item) => {
          return Object.assign({}, item, {
            __key: extractKey(item, description.Table.KeySchema)
          })
        })
      })
      res.render('scan', data)
    })
  }).catch(next)
})

app.get('/tables/:TableName/meta', (req, res) => {
  const TableName = req.params.TableName
  Promise.all([
    describeTable({TableName}),
    docClient.scan({TableName}).promise()
  ]).then(([description, items]) => {
    const data = Object.assign({},
      description,
      items
    )
    res.render('meta', data)
  }).catch((error) => {
    res.json({error})
  })
})

app.delete('/tables/:TableName/items/:key', (req, res, next) => {
  const TableName = req.params.TableName
  describeTable({TableName}).then((result) => {
    const params = {
      TableName,
      Key: parseKey(req.params.key, result.Table)
    }

    return deleteItem(params).then((response) => {
      res.status(204).end()
    })
  }).catch(next)
})

app.get('/tables/:TableName/add-item', (req, res, next) => {
  const TableName = req.params.TableName
  describeTable({TableName}).then((result) => {
    const table = result.Table
    const Item = {}
    table.KeySchema.forEach((key) => {
      const definition = table.AttributeDefinitions.find((attribute) => {
        return attribute.AttributeName === key.AttributeName
      })
      Item[key.AttributeName] = definition.AttributeType === 'S' ? '' : 0
    })
    res.render('item', {
      TableName: req.params.TableName,
      Item: Item,
      isNew: true
    })
  }).catch(next)
})

app.get('/tables/:TableName/items/:key', (req, res, next) => {
  const TableName = req.params.TableName
  describeTable({TableName}).then((result) => {
    const params = {
      TableName,
      Key: parseKey(req.params.key, result.Table)
    }

    return getItem(params).then((response) => {
      if (!response.Item) {
        return res.status(404).send('Not found')
      }
      res.render('item', {
        TableName: req.params.TableName,
        Item: response.Item,
        isNew: false
      })
    })
  }).catch(next)
})

app.put('/tables/:TableName/add-item', bodyParser.json(), (req, res, next) => {
  const TableName = req.params.TableName
  describeTable({TableName}).then((description) => {
    const params = {
      TableName,
      Item: req.body
    }

    return putItem(params).then((response) => {
      const Key = extractKey(req.body, description.Table.KeySchema)
      const params = {
        TableName,
        Key
      }
      return getItem(params).then((response) => {
        if (!response.Item) {
          return res.status(404).send('Not found')
        }
        return res.json(Key)
      })
    })
  }).catch(next)
})

app.put('/tables/:TableName/items/:key', bodyParser.json(), (req, res, next) => {
  const TableName = req.params.TableName
  describeTable({TableName}).then((result) => {
    const params = {
      TableName,
      Item: req.body
    }

    return putItem(params).then(() => {
      const params = {
        TableName,
        Key: parseKey(req.params.key, result.Table)
      }
      return getItem(params).then((response) => {
        return res.json(response.Item)
      })
    })
  }).catch(next)
})

const port = process.env.PORT || 8001
app.listen(port, () => {
  console.log(`dynamodb-admin listening on port ${port}`)
})
